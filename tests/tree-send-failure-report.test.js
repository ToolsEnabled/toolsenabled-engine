'use strict';
// A worker whose agent refuses a turn before naming it is reported to its
// parent, for every driver that reports turns through events (stream-json, ACP,
// direct model connections). Since turn events are bound to the accepted turn,
// such a failed send has no event of its own; it must not end silently.
require('./lib/isolated-environment').activate('tree-send-failure-report');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOpenShellAgentHost } = require('../src/lib/openshell-agent-host');

const settle = () => new Promise(resolve => setImmediate(resolve));
// The lead receives a report in whichever answer comes first: the spawn's own
// receipt when the refusal is that quick, or its next agent.wait.
async function rootReports(host, spawned) {
  const answer = await host.wait({ parentSessionId: 'lead', timeoutSeconds: 1 });
  return [...(spawned.reports || []), ...(answer.reports || [])];
}

function tree(t, sendTurn) {
  const root = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'send-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = [];
  const names = ['memory.get', 'memory.set'];
  const host = createOpenShellAgentHost({
    mode: 'host', env: { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1' },
    rootSessionId: 'lead', workspaceRoot: root, document: { v: 1, nodes: [], inbox: [], root: {}, counter: 0 },
    leadLevel: 4, watchIntervalMs: 0, codexEndpoint: () => null, nodeFolder: id => path.join(root, id),
    roleHooks: { lead: () => ({ roleId: 'controller', surface: { names } }),
      admitChild: ({ childRoleId, parentSurface }) => ({ roleId: childRoleId, surface: parentSurface }), brief: ({ task }) => task },
    launcher: { async start(spec) {
      const session = { spec, threadId: `thread-${sessions.length + 1}`, turnCompletion: 'event', close() {},
        adapter: { sendTurn: request => sendTurn(request, session), pendingTurnForInterrupt: () => null, async interrupt() {} } };
      sessions.push(session);
      return session;
    } },
  });
  t.after(() => host.closeAll());
  return { host, sessions };
}

// The stream-json tier (Claude Code) and an event-reporting session stand for
// every event-driven driver; the driver's own adapter is replaced here.
for (const tier of ['claude-sonnet', 'luna']) {
  test(`${tier}: a send refused before its turn starts is reported and keeps the session`, async t => {
    const f = tree(t, () => Promise.reject(Object.assign(new Error('The agent refused this message: fixture refusal.'),
      { code: 'FIXTURE_SEND_REFUSED' })));
    const worker = await f.host.spawn({ parentSessionId: 'lead', tier, role: 'worker', brief: 'Read state.' });
    await settle(); await settle();
    const node = f.host.list().find(row => row.nodeId === worker.nodeId);
    assert.equal(node.turn, 'idle');
    assert.equal(node.state, 'running', 'a refused send alone does not end the session');
    assert.equal(node.lastTurn.status, 'failed');
    assert.match(node.lastTurn.text, /fixture refusal/);
    assert.deepEqual((await rootReports(f.host, worker)).map(report => [report.status, report.text]),
      [['failed', 'The agent refused this message: fixture refusal.']]);
  });
}

test('a send whose turn the agent never names ends that session and is reported', async t => {
  // Accepted without a turn id: the agent may be running a turn Fleet cannot follow.
  const f = tree(t, async () => ({ text: 'accepted without a turn id' }));
  const worker = await f.host.spawn({ parentSessionId: 'lead', tier: 'claude-sonnet', role: 'worker', brief: 'Read state.' });
  for (let i = 0; i < 5; i += 1) await settle();
  const node = f.host.list().find(row => row.nodeId === worker.nodeId);
  assert.equal(node.state, 'failed');
  assert.equal(node.lastTurn.status, 'failed');
  const reports = await rootReports(f.host, worker);
  assert.equal(reports.length, 1);
  assert.match(reports[0].text, /did not identify the submitted turn/);
});

test('a send refused because the session closed ends the session and is reported', async t => {
  const f = tree(t, () => Promise.reject(Object.assign(new Error('The agent program is no longer accepting input.'),
    { code: 'FIXTURE_SESSION_CLOSED' })));
  const worker = await f.host.spawn({ parentSessionId: 'lead', tier: 'claude-sonnet', role: 'worker', brief: 'Read state.' });
  for (let i = 0; i < 5; i += 1) await settle();
  const node = f.host.list().find(row => row.nodeId === worker.nodeId);
  assert.equal(node.state, 'failed');
  const reports = await rootReports(f.host, worker);
  assert.equal(reports.length, 1);
  assert.match(reports[0].text, /no longer accepting input/);
});
