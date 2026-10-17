'use strict';
// Shared tree behaviour ported from the Windows host line, exercised for every
// worker driver Fleet supports, not only Codex: the app-server driver (Codex),
// stream-json (Claude Code), ACP (Gemini CLI, OpenCode) and a direct model
// connection (local tier or API endpoint). Sessions are stand-ins shaped like
// each driver's real session: app-server answers sendTurn with the accepted
// turn; the others report the turn through events.
require('./lib/isolated-environment').activate('tree-per-provider');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOpenShellAgentHost } = require('../src/lib/openshell-agent-host');
const baseTiers = require('../src/lib/fleet-worker-tiers');

const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const modelRow = { provider: 'fixture-model', adapter: 'model-api', tier: 'cheap', model: 'vendor/fixture', cliModel: 'vendor/fixture',
  connection: { name: 'fixture-model', model: 'vendor/fixture', endpoint: 'http://127.0.0.1:9/v1/chat/completions',
    transport: 'openai-chat', auth: 'none', source: 'local', tier: 'cheap' } };
const PROVIDERS = [
  { name: 'Codex (app-server)', tier: 'luna', events: false },
  { name: 'Claude Code (stream-json)', tier: 'claude-sonnet', events: true },
  { name: 'Gemini CLI (ACP)', tier: 'gemini', events: true },
  { name: 'OpenCode (ACP)', tier: 'opencode', events: true },
  { name: 'direct model connection', tier: 'model-fixture', events: true },
];

function tree(t, { speed = false } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'per-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = [];
  let turns = 0;
  const names = ['memory.get', 'agent.set_speed', 'agent.set_effort'];
  const host = createOpenShellAgentHost({
    mode: 'host', env: { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1', TOOLSENABLED_STATE_ROOT: process.env.TOOLSENABLED_STATE_ROOT },
    rootSessionId: 'lead', workspaceRoot: root, document: { v: 1, nodes: [], inbox: [], root: {}, counter: 0 },
    leadLevel: 4, watchIntervalMs: 0, codexEndpoint: () => null, nodeFolder: id => path.join(root, id),
    tiers: { ...baseTiers, 'model-fixture': modelRow },
    roleHooks: { lead: () => ({ roleId: 'controller', surface: { names } }),
      admitChild: ({ childRoleId, parentSurface }) => ({ roleId: childRoleId, surface: parentSurface }), brief: ({ task }) => task },
    launcher: { async start(spec) {
      const events = !['codex'].includes(spec.provider);
      const session = { spec, threadId: `thread-${sessions.length + 1}`, turns: [], close() {},
        ...(events ? { turnCompletion: 'event' } : {}) };
      session.adapter = {
        sendTurn(request) {
          const record = { ...request, turnId: `turn-${++turns}` };
          session.turns.push(record);
          if (events) return new Promise(resolve => { record.resolve = resolve; });
          return Promise.resolve({ threadId: session.threadId, turnId: record.turnId });
        },
        pendingTurnForInterrupt: () => (events && session.turns.length ? { threadId: session.threadId, turnId: session.turns.at(-1).turnId } : null),
        async interrupt() {},
        ...(speed && spec.provider === 'codex' ? { speedCapabilities: () => ({ choices: ['standard', 'fast'] }) } : {}),
      };
      session.emit = event => spec.onEvent(event);
      session.finish = (text, turn = session.turns.at(-1)) => {
        session.emit({ type: 'assistant_text', threadId: session.threadId, turnId: turn.turnId, text });
        session.emit({ type: 'turn_completed', threadId: session.threadId, turnId: turn.turnId, status: 'completed' });
        if (turn.resolve) turn.resolve({ threadId: session.threadId, turnId: turn.turnId });
      };
      sessions.push(session);
      return session;
    } },
  });
  t.after(() => host.closeAll());
  return { host, sessions };
}

for (const provider of PROVIDERS) {
  test(`${provider.name}: a turn's events complete it and its report reaches the parent; another turn's events do not`, async t => {
    const f = tree(t);
    const worker = await f.host.spawn({ parentSessionId: 'lead', tier: provider.tier, role: 'worker', brief: 'Read state.' });
    await settle();
    const session = f.sessions[0];
    // Events naming another thread or an older turn are not this turn's.
    session.emit({ type: 'turn_completed', threadId: 'other-thread', turnId: session.turns[0].turnId, status: 'completed' });
    session.emit({ type: 'turn_completed', threadId: session.threadId, turnId: 'turn-older', status: 'completed' });
    await settle();
    assert.equal(f.host.list().find(row => row.nodeId === worker.nodeId).turn, 'running');
    session.finish(`${provider.tier} finished`);
    await settle();
    const node = f.host.list().find(row => row.nodeId === worker.nodeId);
    assert.equal(node.turn, 'idle');
    assert.equal(node.lastTurn.text, `${provider.tier} finished`);
    const answer = await f.host.wait({ parentSessionId: 'lead', timeoutSeconds: 1 });
    assert.deepEqual((answer.reports || []).map(report => report.text), [`${provider.tier} finished`]);
  });

  test(`${provider.name}: agent.set_speed ${provider.tier === 'luna' ? 'applies where the adapter offers speed' : 'is refused cleanly, without naming an agent'}`, async t => {
    const f = tree(t, { speed: true });
    const worker = await f.host.spawn({ parentSessionId: 'lead', tier: provider.tier, role: 'worker', brief: 'Read state.' });
    await settle();
    const request = { action: 'set-node-speed', parentSessionId: 'lead', nodeId: worker.nodeId, choice: 'fast' };
    if (provider.tier === 'luna') {
      const receipt = await f.host.command(request);
      assert.equal(receipt.status, 'pending');
      return;
    }
    await assert.rejects(f.host.command(request), error => {
      assert.equal(error.code, 'AGENT_SPEED_UNAVAILABLE');
      assert.doesNotMatch(error.message, /codex|claude|gemini|opencode|openai|anthropic/i);
      return true;
    });
    assert.equal(f.sessions.length, 1, 'no session was restarted');
  });
}
