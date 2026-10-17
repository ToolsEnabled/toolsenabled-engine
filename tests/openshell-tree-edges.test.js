'use strict';
/* The OpenShell agent tree at its edges: what an agent reads when workers on
 * different CLIs finish, fail or pile up reports, and what the tree does with
 * a record or a request it cannot use. Driven through the real tool registry,
 * tree slot and link socket, with stand-in CLI sessions
 * (tests/lib/openshell-tree-harness.js). */
require('./lib/isolated-environment').activate('openshell-tree-edges');
require('./lib/stream-agent').install();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { executeTool: executeToolRaw } = require('../src/lib/tool-registry');
// The MCP entry adds each session's permission ceiling (resolvePermissionSession
// in src/mcp-server.js); these tests call tools directly, so they add the one a
// level-4 lead with no recorded cap gets. The tree's own context carries none.
const LEAD_SESSION = require('../src/lib/permission-tier-policy').effectiveSession(4, 'unrestricted');
const executeTool = (name, args, context = {}) => executeToolRaw(name, args,
  context.permissionSession === undefined ? { ...context, permissionSession: LEAD_SESSION } : context);
const store = require('../src/lib/openshell-tree-store');
const { CONTRACT, scratch, settle, standIns, treeModes } = require('./lib/openshell-tree-harness');

const { startMode, workerServer, closeAll } = treeModes();
test.afterEach(closeAll);

test('a report says how a turn ended in the same words whichever CLI ran it', async () => {
  const stand = standIns();
  const mode = startMode(stand);
  await mode.ready;
  const ended = [
    ['luna', 'completed'], ['sample-fable', 'success'],
    ['terra', 'failed'], ['sample-sonnet', 'error_max_turns'],
  ];
  // Each answer to the lead carries the reports waiting for it.
  const reports = [];
  for (const [tier, cliStatus] of ended) {
    reports.push(...((await executeTool('agent.spawn', { contract: CONTRACT, tier, surface: 'tree' }, mode.context)).reports || []));
    stand.last().finish(`ended ${cliStatus}`, cliStatus);
    await settle();
  }
  const answer = await executeTool('agent_comms.local_roster', { from: 'Claude Code' }, mode.context);
  reports.push(...answer.reports);
  assert.deepEqual(reports.map(report => [report.text, report.status, report.cliStatus]), [
    ['ended completed', 'completed', undefined],
    ['ended success', 'completed', undefined],
    ['ended failed', 'failed', undefined],
    ['ended error_max_turns', 'failed', 'error_max_turns'],
  ]);
  assert.deepEqual(answer.agents.map(agent => agent.lastTurn.status), ['completed', 'completed', 'failed', 'failed'],
    'the roster uses the same words');
  assert.deepEqual(mode.host.list().map(node => node.lastTurn.status), ['completed', 'completed', 'failed', 'failed'],
    'and so does the saved tree the terminal page prints');
});

test('one answer carries only as many reports as a CLI keeps of a result; the rest come on the next', async () => {
  const stand = standIns();
  const mode = startMode(stand);
  await mode.ready;
  for (let index = 0; index < 4; index += 1) {
    await executeTool('agent.spawn', { contract: CONTRACT, tier: 'luna', surface: 'tree' }, mode.context);
  }
  // Four workers each end with a report at the 12,000-character limit.
  for (const session of stand.sessions) {
    session.finish(`${session.spec.nodeId}: ${'every test passed; here is what each one checked. '.repeat(300)}`);
    await settle();
  }
  const seen = [];
  for (let call = 0; call < 4 && seen.length < 4; call += 1) {
    const answer = await executeTool('agent_comms.local_roster', { from: 'Claude Code' }, mode.context);
    assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= 32 * 1024, `answer ${call} fits in 32 KiB of result text`);
    assert.ok(answer.reports.length >= 1, 'every answer with reports waiting carries at least one');
    assert.equal(answer.moreReports || 0, 4 - seen.length - answer.reports.length, 'the rest are counted');
    seen.push(...answer.reports.map(report => report.nodeId));
  }
  assert.deepEqual(seen, stand.sessions.map(session => session.spec.nodeId), 'each report is delivered once, in order');
  assert.equal((await executeTool('agent_comms.local_roster', { from: 'Claude Code' }, mode.context)).reports, undefined);
});

test('a tree record that cannot be used is kept aside and the server starts with an empty tree', async () => {
  const records = {
    truncated: ['tree.json', '{"v":1,"treeKey":"claude","nodes":[{"nodeId":"openshell-node-1-a'],
    'a node that is not an object': ['tree.json', '{"v":1,"treeKey":"claude","counter":1,"nodes":[null],"inbox":[]}'],
    'nodes that are not a list': ['tree.json', '{"v":1,"treeKey":"claude","nodes":{"a":1},"inbox":[]}'],
    'another version': ['tree.json', '{"v":2,"treeKey":"claude","nodes":[],"inbox":[]}'],
    'an unreadable owner file': ['owner.json', 'garbage'],
  };
  for (const [label, [file, text]] of Object.entries(records)) {
    const stateRoot = scratch();
    const folder = path.join(stateRoot, 'openshell-tree', 'claude');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, file), text);
    const mode = startMode(standIns(), { stateRoot });
    await mode.ready;
    assert.equal(mode.treeKey, 'claude', label);
    const spawned = await executeTool('agent.spawn', { contract: CONTRACT, tier: 'luna', surface: 'tree' }, mode.context);
    assert.equal(spawned.displayName, 'Worker 1', `${label}: the tree works`);
    const kept = fs.readdirSync(folder).filter(name => name.startsWith('tree.json.unreadable-'));
    if (file === 'tree.json') {
      assert.equal(kept.length, 1, `${label}: the old record is kept`);
      assert.equal(fs.readFileSync(path.join(folder, kept[0]), 'utf8'), text, `${label}: unchanged`);
      assert.match(store.formatTrees(store.listTrees(stateRoot)).join('\n'), /an earlier record of this tree could not be used and was kept as .*tree\.json\.unreadable-/);
    } else {
      assert.equal(kept.length, 0, `${label}: nothing to keep aside`);
    }
    await closeAll();
  }
});

test('inside a sandbox a lane is refused as an input the tool does not take, never started, and a setting that closes the tree says how to reopen it', async t => {
  const { toolError } = require('../src/mcp-server');
  const stand = standIns();
  const mode = startMode(stand);
  await mode.ready;
  const sentence = async call => {
    const error = await call.then(() => null, caught => caught);
    assert.ok(error, 'refused');
    return { code: error.code, text: toolError(error).content[0].text };
  };
  // The server's own environment carries the two markers, as setup writes them.
  const markers = { OPENSHELL_SANDBOX: process.env.OPENSHELL_SANDBOX, TOOLSENABLED_OPENSHELL_AGENTS: process.env.TOOLSENABLED_OPENSHELL_AGENTS };
  Object.assign(process.env, { OPENSHELL_SANDBOX: '1', TOOLSENABLED_OPENSHELL_AGENTS: '1' });
  t.after(() => { for (const [name, value] of Object.entries(markers)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  // Fleet offers only the tree, so a detached lane is refused as an input the tool does not take.
  const lane = await sentence(executeTool('agent.spawn', { contract: CONTRACT, tier: 'luna', surface: 'lane' }, mode.context));
  assert.equal(lane.code, 'INVALID_PARAMS', lane.text);
  assert.match(lane.text, /surface/, lane.text);
  assert.match(lane.text, /tree/, lane.text);
  assert.equal(stand.sessions.length, 0, 'nothing was started');

  require('../src/lib/openshell-settings-page').set([['agent.subagent_route', 'Never on your tree']]);
  try {
    for (const surface of [undefined, 'tree']) {
      const closed = await sentence(executeTool('agent.spawn', { contract: CONTRACT, tier: 'luna', ...(surface ? { surface } : {}) }, mode.context));
      assert.equal(closed.code, 'AGENT_SPAWN_TREE_ROUTE_CLOSED');
      assert.match(closed.text, /the tree is the only place a worker can run, so nothing was started\. The person can change it with `toolsenabled settings set agent\.subagent_route "Let the assistant decide"`/);
    }
    assert.equal(stand.sessions.length, 0);
  } finally {
    require('../src/lib/openshell-settings-page').set([['agent.subagent_route', 'Let the assistant decide']]);
  }
  const worker = await executeTool('agent.spawn', { contract: CONTRACT, tier: 'luna' }, mode.context);
  assert.equal(worker.displayName, 'Worker 1', 'with nothing asked, a worker joins the tree');
});


test('report batches retain undelivered records without needing a worker socket', async () => {
  const document = { v: 1, treeKey: 'root', root: {}, counter: 0, nodes: [],
    inbox: ['success', 'completed', 'failed', 'interrupted'].map((status, index) => ({
      id: `report-${index}`, from: `Worker ${index}`, fromNodeId: `worker-${index}`,
      kind: 'report', status, text: 'report text '.repeat(1000), at: new Date().toISOString()
    })) };
  const host = require('../src/lib/openshell-agent-host').createOpenShellAgentHost({
    rootSessionId: 'root-session', workspaceRoot: scratch(), document,
    env: { OPENSHELL_SANDBOX: '1', TOOLSENABLED_OPENSHELL_AGENTS: '1' },
    launcher: { start: async () => { throw new Error('No worker is needed.'); } },
    roleHooks: { lead: () => null }, watchIntervalMs: 0, leadLevel: 2
  });
  const seen = [];
  try {
    for (let index = 0; index < 4 && seen.length < 4; index++) {
      const result = await host.localComms.roster({}, { agentPrincipal: { sessionId: 'root-session' } });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32 * 1024);
      seen.push(...result.reports);
      assert.equal(result.moreReports || 0, 4 - seen.length);
    }
    assert.deepEqual(seen.map(report => report.nodeId), document.inbox.map(report => report.fromNodeId));
    assert.deepEqual(seen.map(report => report.status), ['completed', 'completed', 'failed', 'interrupted']);
    assert.ok(document.inbox.every(report => report.deliveredAt));
    assert.equal((await host.localComms.roster({}, { agentPrincipal: { sessionId: 'root-session' } })).reports, undefined);
  } finally { await host.closeAll(); }
});

test('corrupt tree data is preserved intact before an empty record is returned', () => {
  const stateRoot = scratch();
  const folder = path.join(stateRoot, 'openshell-tree', 'test-root');
  fs.mkdirSync(folder, { recursive: true });
  const text = '{"v":1,"nodes":[null]';
  fs.writeFileSync(path.join(folder, 'tree.json'), text);
  const tree = store.acquireTree({ stateRoot, baseKey: 'test-root', root: {} });
  try {
    assert.deepEqual(tree.document.nodes, []);
    assert.equal(fs.readFileSync(tree.document.setAside.file, 'utf8'), text);
  } finally { tree.release(); }
});
