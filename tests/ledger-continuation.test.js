'use strict';
require('./lib/isolated-environment').activate('ledger-continuation');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../src/lib/owner-request-store');
const { createLedgerContinuationController, fingerprint } = require('../src/lib/ledger-continuation-controller');
const { createOpenShellAgentHost } = require('../src/lib/openshell-agent-host');
const treeStore = require('../src/lib/openshell-tree-store');
const registry = require('../src/lib/tool-registry');
const treeRegistry = require('../src/lib/tree-host-registry');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const names = ['agent.continue', 'agent.spawn', 'ledger.read', 't_ledger.file', 't_ledger.progress', 't_ledger.complete'];
function ledgerFixture(t) {
  const folder = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'continuation-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const options = { ledgerFile: path.join(folder, 'owner-ledger.json'), taskDifficultyEnabled: false };
  // Follow the public store's exact options, no hand-edited JSON task records.
  const read = () => store.readAll({ ...options, kinds: ['T'], includeRemoved: true });
  const file = (key, words, extra = {}) => store.fileTask({ scope: 'tree', key, words, filedBy: 'codex', difficulty: 'easy', ...extra }, options).id;
  const complete = id => store.completeTask({ id, actor: 'codex' }, options);
  const progress = (id, status, reason, waitingFor) => store.progressTask({ id, status, reason, actor: 'codex', ...(waitingFor ? { waitingFor } : {}) }, options);
  return { folder, options, read, file, complete, progress };
}
function standalone(t, { continuationEnabled = () => true } = {}) {
  const f = ledgerFixture(t);
  const sessions = [];
  let turn = 0;
  const document = { v: 1, treeKey: 'fixture', root: {}, counter: 0, nodes: [], inbox: [] };
  const env = { ...process.env, TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1' };
  const host = createOpenShellAgentHost({ mode: 'host', rootSessionId: 'root-session', workspaceRoot: f.folder, env,
    root: { agentId: 'codex', displayName: 'Lead' }, document, watchIntervalMs: 0, leadLevel: 3,
    continuationLedger: f.read, continuationEnabled,
    persist: doc => treeStore.saveTree(path.join(f.folder, 'tree.json'), doc),
    roleHooks: { lead: () => ({ roleId: 'controller', surface: { names } }),
      admitChild: () => ({ roleId: 'worker', surface: { names } }), brief: ({ task }) => task },
    launcher: { async start(spec) {
      const session = { spec, threadId: 'fixture-thread', turns: [], close: async () => {},
        adapter: { sendTurn(request) {
          const next = { ...request, turnId: `turn-${++turn}` }; session.turns.push(next);
          if (session.deferNextAcceptance) {
            session.deferNextAcceptance = false;
            return new Promise(resolve => { session.acceptPending = () => resolve(next); });
          }
          return Promise.resolve(next);
        }, interrupt: async () => {} } };
      session.finish = status => spec.onEvent({ type: 'turn_completed', threadId: session.threadId, turnId: session.turns.at(-1).turnId, status: status || 'completed', text: 'Narration alone is not progress.' });
      sessions.push(session); return session;
    } }, codexEndpoint: () => null,
  });
  treeRegistry.installTreeSpawnHost(host);
  const context = { permissionSession: { origin: 'local', tier: 'full' }, agentId: 'codex',
    agentPrincipal: { sessionId: 'root-session', agentId: 'codex' }, agentRole: { functions: names, requiresDirectUserAuthorization: false }, allowedToolNames: names };
  t.after(async () => { await host.closeAll(); treeRegistry.clearTreeSpawnHost(); });
  return { ...f, host, sessions, document, context };
}
async function enroll(f, nodeId, taskIds, runId = 'acceptance', maxTurns) {
  return registry.executeTool('agent.continue', { nodeId, taskIds, runId, ...(maxTurns === undefined ? {} : { maxTurns }) }, f.context);
}
test('real T ledger + real host/tool dispatch: finishing first task starts dependent second without a prompt; terminal completion stops', async t => {
  const f = standalone(t);
  const worker = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await assigned work.' });
  const [session] = f.sessions;
  const first = f.file(worker.nodeId, 'Complete first fixture task');
  const second = f.file(worker.nodeId, 'Complete dependent task');
  f.progress(second, 'open', 'Wait for first fixture result.', [first]);
  await enroll(f, worker.nodeId, [first, second]);
  assert.equal(session.turns.length, 1, 'enrolling a busy worker does not overlap its turn');
  session.finish(); await settle();
  assert.equal(session.turns.length, 2); assert.match(session.turns[1].text, new RegExp(`task ${first}`));
  f.complete(first); session.finish(); await settle();
  assert.equal(session.turns.length, 3); assert.match(session.turns[2].text, new RegExp(`task ${second}`));
  const prior = session.turns[1];
  session.spec.onEvent({ type: 'interaction_required', threadId: session.threadId, turnId: prior.turnId });
  session.spec.onEvent({ type: 'approval_request', threadId: session.threadId, turnId: prior.turnId });
  assert.equal(f.host.list()[0].continuation.state, 'running', 'stale interaction cannot pause current turn');
  session.spec.onEvent({ type: 'turn_completed', turnId: prior.turnId, status: 'completed' });
  await settle(); assert.equal(f.host.list()[0].turn, 'running', 'late prior completion cannot finish current turn');
  f.complete(second); session.finish(); await settle();
  assert.equal(f.host.list()[0].continuation.state, 'done');
  await f.host.checkWorkers(); assert.equal(session.turns.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.folder, 'tree.json'))).nodes[0].continuation.turns, 2);
});
test('unchanged narration stops after three attempts; unrelated ledger revisions never count as progress; other assigned work can continue', async t => {
  const f = standalone(t);
  const worker = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await.' });
  const [session] = f.sessions;
  const unchanged = f.file(worker.nodeId, 'Stuck task');
  const next = f.file(worker.nodeId, 'Other task');
  await enroll(f, worker.nodeId, [unchanged, next]); session.finish(); await settle();
  for (let n = 0; n < 3; n++) { f.file('other-node', `Unrelated ${n}`); session.finish(); await settle(); }
  assert.equal(session.turns.length, 5); assert.match(session.turns.at(-1).text, new RegExp(`task ${next}`));
  f.complete(next); session.finish(); await settle();
  assert.deepEqual(f.host.list()[0].continuation.waiting, [{ taskId: unchanged, reason: 'no-progress' }]);
  await enroll(f, worker.nodeId, [unchanged, next]);
  await f.host.checkWorkers(); assert.equal(session.turns.length, 5, 'idempotent enrollment and watch do not reset hold');
  f.progress(unchanged, 'in-progress', 'Verified a new result is available.');
  await f.host.checkWorkers(); assert.equal(session.turns.length, 6, 'new concrete checkpoint re-enables held work');
});
test('blocked, unavailable dependency, removed and global tasks cannot launch; changing blocker wakes without prompt', async t => {
  const f = standalone(t);
  const worker = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await.' });
  const [session] = f.sessions;
  const blocked = f.file(worker.nodeId, 'Blocked'); f.progress(blocked, 'blocked-external', 'Need an external result.');
  const global = f.file(undefined, 'Unassigned global task', { scope: 'global' });
  await assert.rejects(enroll(f, worker.nodeId, [global]), { code: 'CONTINUATION_TASK_NOT_ASSIGNED' });
  const other = f.file('other-node', 'Wrong owner');
  await assert.rejects(enroll(f, worker.nodeId, [other]), { code: 'CONTINUATION_TASK_NOT_ASSIGNED' });
  await enroll(f, worker.nodeId, [blocked]); session.finish(); await settle();
  for (let n = 0; n < 5; n++) await f.host.checkWorkers();
  assert.equal(session.turns.length, 1); assert.equal(f.host.list()[0].continuation.waiting[0].reason, 'blocked-external');
  f.progress(blocked, 'open', 'External result received.'); await f.host.checkWorkers();
  assert.equal(session.turns.length, 2);
});
test('approval interaction, unsuccessful turn, cancellation and turn budget pause without spin', async t => {
  for (const scenario of ['interaction', 'failure', 'stop', 'budget']) await t.test(scenario, async t => {
    const f = standalone(t);
    const worker = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await.' });
    const [session] = f.sessions; const id = f.file(worker.nodeId, 'Task');
    await enroll(f, worker.nodeId, [id], scenario, 1); session.finish(); await settle();
    if (scenario === 'interaction') session.spec.onEvent({ type: 'interaction_required', threadId: session.threadId, turnId: session.turns.at(-1).turnId, payload: { state: 'pending' } });
    if (scenario === 'stop') await f.host.command({ parentSessionId: 'root-session', nodeId: worker.nodeId, action: 'stop-node' });
    else session.finish(scenario === 'failure' ? 'failed' : 'completed');
    await settle(); for (let n = 0; n < 4; n++) await f.host.checkWorkers();
    assert.equal(session.turns.length, 2); assert.equal(f.host.list()[0].continuation.state, 'paused');
    assert.equal(f.host.list()[0].continuation.reason, { interaction: 'interaction-required', failure: 'turn-not-successful', stop: 'stopped-by-manager', budget: 'turn-budget-exhausted' }[scenario]);
  });
});
// Found by the per-provider review of the Windows host line's a76b012: only
// approval_request/interaction_required events paused continuation. Claude Code
// and ACP agents report a denied permission on the completed turn instead, and a
// Codex worker without a route reports declined prompts there.
test('a turn with a denied permission or a declined question pauses continuation for every driver', async t => {
  for (const [name, payload] of [['permission-denied', { permissionDenied: true, permissionDeniedTools: ['Write'] }],
    ['prompt-declined', { promptDeclined: { count: 1, from: ['toolsenabled'] } }]]) await t.test(name, async t => {
    const f = standalone(t);
    const worker = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await.' });
    const [session] = f.sessions; const id = f.file(worker.nodeId, 'Task');
    await enroll(f, worker.nodeId, [id], name, 5); session.finish(); await settle();
    const turns = session.turns.length;
    session.spec.onEvent({ type: 'turn_completed', threadId: session.threadId, turnId: session.turns.at(-1).turnId,
      status: 'completed', text: 'Could not write.', payload });
    await settle(); for (let n = 0; n < 4; n++) await f.host.checkWorkers();
    assert.equal(session.turns.length, turns, 'no further automatic turn');
    assert.equal(f.host.list()[0].continuation.state, 'paused');
    assert.equal(f.host.list()[0].continuation.reason, 'interaction-required');
  });
});

test('durable interrupted attempt survives controller restart without replay; changed checkpoint is required for re-enrollment', async t => {
  const f = ledgerFixture(t), node = { nodeId: 'assigned-worker' }, file = path.join(f.folder, 'saved.json');
  const id = f.file(node.nodeId, 'Task with effects'); let sends = 0;
  const create = node => createLedgerContinuationController({ nodes: () => [node], readTasks: f.read,
    persist: () => fs.writeFileSync(file, JSON.stringify(node)), canSend: () => true, send: async () => { sends++; } });
  const original = create(node); original.enroll(node, { runId: 'old', taskIds: [id] }, 'codex'); await original.tick(node);
  const restored = JSON.parse(fs.readFileSync(file)); const next = create(restored); next.recover(restored);
  await next.tick(restored); assert.equal(sends, 1); assert.equal(next.view(restored).reason, 'restart-review-required');
  assert.throws(() => next.enroll(restored, { runId: 'new', taskIds: [id] }, 'codex'), { code: 'CONTINUATION_RECONCILIATION_REQUIRED' });
  f.progress(id, 'in-progress', 'Reconciled saved transcript: prior attempt produced the first result.');
  next.enroll(restored, { runId: 'new', taskIds: [id] }, 'codex'); await next.tick(restored); assert.equal(sends, 2);
});
test('persist failure cannot dispatch; identical checkpoints with new timestamps do not reset no-progress', async t => {
  const f = ledgerFixture(t), node = { nodeId: 'assigned-worker' }; const id = f.file(node.nodeId, 'Task');
  let failPersist = false, sends = 0;
  const c = createLedgerContinuationController({ nodes: () => [node], readTasks: f.read, canSend: () => true,
    persist: () => { if (failPersist) throw new Error('disk full'); }, send: async () => { sends++; } });
  c.enroll(node, { runId: 'persist', taskIds: [id] }, 'codex'); failPersist = true;
  await assert.rejects(c.tick(node), { code: 'CONTINUATION_PERSISTENCE_FAILED' }); assert.equal(sends, 0);
  const base = { words: 'Task', status: 'in-progress', decisions: [{ decision: 'progress', reason: 'Same result', at: 'old' }] };
  const changedTime = { ...base, decisions: [{ decision: 'progress', reason: 'Same result', at: 'new' }] };
  assert.equal(fingerprint(base), fingerprint(changedTime));
});

test('disabling continuation and saved feature switch stop further turns without stopping an active turn', async t => {
  let enabled = true;
  const f = standalone(t, { continuationEnabled: () => enabled });
  const worker = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await.' });
  const [session] = f.sessions, id = f.file(worker.nodeId, 'Task');
  await enroll(f, worker.nodeId, [id]); session.finish(); await settle();
  await registry.executeTool('agent.continue', { nodeId: worker.nodeId, enabled: false }, f.context);
  assert.equal(f.host.list()[0].turn, 'running');
  session.finish(); await settle(); await f.host.checkWorkers(); assert.equal(session.turns.length, 2);
  assert.equal(f.host.list()[0].continuation.state, 'disabled');
  f.progress(id, 'in-progress', 'Checked cancelled attempt result.');
  enabled = false;
  await assert.rejects(enroll(f, worker.nodeId, [id], 'disabled-new'), { code: 'CONTINUATION_DISABLED' });
  enabled = true; await enroll(f, worker.nodeId, [id], 'new');
  enabled = false; session.finish(); await settle();
  assert.equal(f.host.list()[0].continuation.reason, 'disabled-in-settings'); assert.equal(session.turns.length, 3);
});
test('controller filters malformed dependencies, terminal tasks, stale ownership, reset and handoff records', async () => {
  const node = { nodeId: 'worker' }, sent = [];
  const base = (id, fields = {}) => ({ kind: 'T', id, scope: 'tree', scopeKey: 'worker', status: 'open', verbatim: 'Task', ...fields });
  // Two-digit ids: the public-source scan treats single-digit task labels above four as private.
  const records = [base('T11'), base('T12'), base('T13'), base('T14'), base('T15'), base('T16')];
  const c = createLedgerContinuationController({ nodes: () => [node], readTasks: () => ({ records }), persist() {}, canSend: () => true, send: async (_node, text) => sent.push(text) });
  c.enroll(node, { runId: 'filter', taskIds: records.map(row => row.id) }, 'manager');
  records[0].waitingFor = { invalid: true };
  records[1].status = 'removed'; records[2].ownerNodeId = 'different-worker'; records[3].reset = {};
  records[4].handoff = { publicationState: 'pending' }; records[5].waitingFor = ['T12'];
  await c.tick(node); assert.equal(sent.length, 0);
  assert.equal(c.view(node).waiting.length, 5);
});
test('local transport, descendant, session, explicit role grant and direct-user-only gates refuse before dispatch', async t => {
  const f = standalone(t), worker = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await.' });
  const [session] = f.sessions, id = f.file(worker.nodeId, 'Task');
  await assert.rejects(registry.executeTool('agent.continue', { nodeId: worker.nodeId, taskIds: [id], runId: 'remote' },
    { ...f.context, permissionSession: { origin: 'remote', tier: 'full' } }));
  await assert.rejects(f.host.command({ parentSessionId: 'unknown', action: 'set-node-continuation', nodeId: worker.nodeId,
    choice: { runId: 'unknown', taskIds: [id] } }), { code: 'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT' });
  await assert.rejects(f.host.command({ parentSessionId: 'root-session', action: 'set-node-continuation', nodeId: worker.nodeId,
    expectedSessionId: 'stale', choice: { runId: 'stale', taskIds: [id] } }), { code: 'TREE_CONFIGURATION_REFUSED' });
  await assert.rejects(f.host.command({ parentSessionId: worker.sessionId, action: 'set-node-continuation', nodeId: worker.nodeId,
    choice: { runId: 'self', taskIds: [id] } }), { code: 'TREE_CONFIGURATION_REFUSED' });
  const node = f.document.nodes[0]; node.surface.requiresDirectUserAuthorization = true;
  await assert.rejects(enroll(f, worker.nodeId, [id]), { code: 'CONTINUATION_DIRECT_TURN_REQUIRED' });
  node.surface.requiresDirectUserAuthorization = false;
  const oldNames = f.host.root.surface.names.splice(0);
  await assert.rejects(f.host.command({ parentSessionId: 'root-session', action: 'set-node-continuation', nodeId: worker.nodeId,
    choice: { runId: 'no-grant', taskIds: [id] } }), { code: 'TOOL_NOT_ENABLED' });
  f.host.root.surface.names.push(...oldNames);
  assert.equal(session.turns.length, 1);
});
test('kill switch pauses the owned lane and removing it does not silently unpause', async t => {
  const f = standalone(t), worker = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await.' });
  const [session] = f.sessions, id = f.file(worker.nodeId, 'Task');
  await enroll(f, worker.nodeId, [id]);
  fs.writeFileSync(process.env.TOOLSENABLED_KILLSWITCH_PATH, 'stop');
  try { session.finish(); await settle(); assert.equal(session.turns.length, 1); assert.equal(f.host.list()[0].continuation.reason, 'kill-switch-active'); }
  finally { fs.unlinkSync(process.env.TOOLSENABLED_KILLSWITCH_PATH); }
  await f.host.checkWorkers(); assert.equal(session.turns.length, 1, 'removing kill switch does not silently unpause');
});

test('public tree projects waiting continuation instead of falsely reporting all work done', () => {
  const view = require('../src/lib/fleet-tree-view').projectTrees([{ treeKey: 'fixture', live: true,
    document: { root: {}, nodes: [{ nodeId: 'worker', state: 'running', turn: 'idle', lastTurn: { status: 'completed' },
      continuation: { state: 'paused', reason: 'interaction-required', taskIds: ['T1'], turns: 1, maxTurns: 20 } }] } }]);
  assert.equal(view.trees[0].nodes[1].state, 'waiting');
  assert.equal(view.trees[0].nodes[1].continuation.reason, 'interaction-required');
});

test('last allowed turn completing its task reports done, not budget exhaustion', async t => {
  const f = ledgerFixture(t), node = { nodeId: 'worker' }, id = f.file('worker', 'Complete exactly once');
  const c = createLedgerContinuationController({ nodes: () => [node], readTasks: f.read, persist() {}, canSend: () => true, send: async () => {} });
  c.enroll(node, { runId: 'one', taskIds: [id], maxTurns: 1 }, 'manager'); await c.tick(node);
  f.complete(id); c.completed(node, 'completed'); await c.tick(node); assert.equal(c.view(node).state, 'done');
});
// NO WORK BUDGETS (2026-10-17): continuation had a default of 20 turns and a
// maximum of 100 that no manager could lift. Nobody asked for either.
test('without maxTurns a run is never stopped for its turn count', async t => {
  const f = ledgerFixture(t), node = { nodeId: 'worker' }, id = f.file('worker', 'A long task');
  let sent = 0;
  const c = createLedgerContinuationController({ nodes: () => [node], readTasks: f.read, persist() {}, canSend: () => true, send: async () => { sent++; } });
  assert.equal(c.enroll(node, { runId: 'long', taskIds: [id] }, 'manager').maxTurns, null);
  for (let n = 1; n <= 150; n++) {
    assert.equal(await c.tick(node), true, `turn ${n} was sent`);
    f.progress(id, 'in-progress', `Step ${n} recorded.`); c.completed(node, 'completed');
  }
  assert.equal(sent, 150); assert.equal(c.view(node).turns, 150); assert.equal(c.view(node).state, 'ready');
  f.complete(id); await c.tick(node); assert.equal(c.view(node).state, 'done');
});
test('a manager may ask for any turn limit from 1 through the tool; none is imposed', async t => {
  const f = standalone(t);
  const worker = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await.' });
  const id = f.file(worker.nodeId, 'Task');
  await assert.rejects(enroll(f, worker.nodeId, [id], 'zero', 0));
  await enroll(f, worker.nodeId, [id], 'big', 1000);
  assert.equal(f.host.list()[0].continuation.maxTurns, 1000);
  const other = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await.' });
  await enroll(f, other.nodeId, [f.file(other.nodeId, 'Task')], 'open');
  assert.equal(f.host.list().find(node => node.nodeId === other.nodeId).continuation.maxTurns, null);
});
test('the tree shows a long run\'s real turn count and an absent limit as null', () => {
  const view = require('../src/lib/fleet-tree-view').projectTrees([{ treeKey: 'fixture', live: true,
    document: { root: {}, nodes: [{ nodeId: 'worker', state: 'running', turn: 'idle', lastTurn: { status: 'completed' },
      continuation: { state: 'ready', taskIds: ['T1'], turns: 250, maxTurns: null } }] } }]);
  assert.equal(view.trees[0].nodes[1].continuation.turns, 250);
  assert.equal(view.trees[0].nodes[1].continuation.maxTurns, null);
});
test('malformed saved continuation cannot run or crash the rest of the host', () => {
  const node = { nodeId: 'worker', continuation: { taskIds: 'not-a-list' } };
  const c = createLedgerContinuationController({ nodes: () => [node], readTasks: () => ({ records: [] }), persist() {}, canSend: () => true, send: async () => assert.fail('no dispatch') });
  c.recover(node); assert.equal(c.view(node).reason, 'invalid-saved-state');
});

test('continuation is advertised only by the standalone host surface', () => {
  assert.equal(require('../src/lib/host-surface').hostAllowlist({ workers: true }).includes('agent.continue'), true);
  assert.equal(require('../src/lib/openshell-surface').OPENSHELL_AGENT_TOOLS.includes('agent.continue'), false);
  assert.equal(require('../src/lib/host-surface').hostAllowlist({ workers: false }).includes('agent.continue'), false);
});

test('deferred provider acceptance correlates all turn effects and preserves valid early events', async t => {
  for (const early of ['stale-only', 'current-completion', 'current-interaction']) await t.test(early, async t => {
    const f = standalone(t);
    const worker = await f.host.spawn({ parentSessionId: 'root-session', tier: 'luna', brief: 'Await.' });
    const [session] = f.sessions;
    const first = f.file(worker.nodeId, 'First task'), second = f.file(worker.nodeId, 'Second task');
    await enroll(f, worker.nodeId, [first, second]); session.finish(); await settle();
    f.complete(first); session.deferNextAcceptance = true; session.finish(); await settle();
    assert.equal(session.turns.length, 3);
    const node = f.document.nodes[0], current = session.turns[2], previous = session.turns[1], older = session.turns[0];
    const emit = (type, turnId, extra = {}) => session.spec.onEvent({ type, threadId: session.threadId, turnId, ...extra });
    const before = JSON.stringify(node.continuation);
    emit('turn_completed', previous.turnId, { status: 'completed', text: 'stale finish' });
    emit('approval_request', previous.turnId);
    emit('interaction_required', older.turnId, { payload: { state: 'pending' } });
    emit('assistant_text', older.turnId, { text: 'stale text' });
    emit('turn_completed', undefined, { status: 'completed' });
    await settle();
    assert.equal(node.turn, 'running'); assert.equal(node.waitingForApproval, false);
    assert.equal(node.lastTurn.turnId, previous.turnId); assert.equal(session.turns.length, 3);
    assert.equal(JSON.stringify(node.continuation), before, 'uncorrelated events have no ledger scheduling effect');
    if (early === 'current-completion') { f.complete(second); emit('turn_completed', current.turnId, { status: 'completed', text: 'valid early finish' }); }
    if (early === 'current-interaction') { emit('approval_request', current.turnId); emit('interaction_required', current.turnId, { payload: { state: 'pending' } }); }
    assert.equal(node.turn, 'running'); assert.equal(node.waitingForApproval, false, 'valid early effect waits for identity too');
    session.acceptPending(); await settle();
    assert.equal(session.turns.length, 3, 'no duplicate dispatch around acknowledgement');
    if (early === 'current-completion') {
      assert.equal(node.turn, 'idle'); assert.equal(node.continuation.state, 'done');
      assert.equal(node.lastTurn.turnId, current.turnId); assert.equal(node.lastTurn.text, 'valid early finish');
    } else if (early === 'current-interaction') {
      assert.equal(node.turn, 'running'); assert.equal(node.waitingForApproval, true);
      assert.equal(node.continuation.state, 'paused'); assert.equal(node.continuation.reason, 'interaction-required');
      session.finish(); await settle(); assert.equal(node.continuation.state, 'paused');
    } else {
      assert.equal(node.turn, 'running'); assert.equal(node.waitingForApproval, false); assert.equal(node.continuation.state, 'running');
      emit('turn_completed', previous.turnId, { status: 'completed' });
      emit('approval_request', older.turnId); emit('interaction_required', older.turnId);
      session.spec.onEvent({ type: 'turn_completed', threadId: 'wrong-thread', turnId: current.turnId, status: 'completed' });
      assert.equal(node.turn, 'running'); assert.equal(node.waitingForApproval, false); assert.equal(node.continuation.state, 'running');
      f.complete(second); session.finish(); await settle(); assert.equal(node.continuation.state, 'done');
    }
  });
});
test('continuation prompt carries only canonical task ID; no truncated or invented preview is substituted', async t => {
  const f = ledgerFixture(t), node = { nodeId: 'worker' }, sent = [];
  const id = f.file('worker', 'CANONICAL TASK DETAIL '.repeat(100));
  const c = createLedgerContinuationController({ nodes: () => [node], readTasks: f.read, persist() {}, canSend: () => true, send: async (_node, text) => sent.push(text) });
  c.enroll(node, { runId: 'id-only', taskIds: [id] }, 'manager'); await c.tick(node);
  assert.match(sent[0], new RegExp(`task ${id}`)); assert.match(sent[0], /ledger.read before acting/);
  assert.doesNotMatch(sent[0], /CANONICAL TASK DETAIL/);
  assert.ok(f.read().records.find(task => task.id === id).verbatim.endsWith('DETAIL'), 'canonical ledger retains task words');
});
