'use strict';
require('./lib/isolated-environment').activate('f3-canonical-policy');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const filename = path.join(__dirname, '../src/lib/openshell-agent-host.js');
const changes = {
  forwarding: ["{ launchObservation: observation?.observe || null }", '{ launchObservation: null }'],
  canonicalCommit: ['if (observation) launchPolicy.host.commitLaunch(observation.handle, session.threadId);', ''],
  supportedProvider: ["if (driverOf(node.provider) === 'app-server') {", 'if (false) {'],
  activeScope: ["!['starting', 'running'].includes(node.state)", 'false'],
  sessionThread: ["(node.state === 'running' && (!state.session || state.session.threadId !== node.threadId))", 'false'],
  capturedParent: ['parentSessionId: state.launchParentSessionId,', 'parentSessionId: node.parentNodeId ? byId(node.parentNodeId)?.sessionId : rootSessionId,'],
  guiUnknown: ['parent?.launchPolicy?.handle', 'live.get(document.nodes[0]?.nodeId)?.launchPolicy?.handle'],
  privatePersistence: ['save();\n    } catch (error) {\n      if (observation)', 'node.parentPolicyObservation = parentPolicyObservation(node);\n      save();\n    } catch (error) {\n      if (observation)']
};
function loadHost() {
  const mutation = process.env.F3_CANONICAL_POLICY_MUTATION;
  if (!mutation) return require(filename);
  const source = fs.readFileSync(filename, 'utf8'), change = changes[mutation];
  if (!change || !source.includes(change[0])) throw Error('Canonical mutant not applicable');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths;
  loaded._compile(source.replace(change[0], change[1]), filename); return loaded.exports;
}
const { createOpenShellAgentHost } = loadHost();
const { createHostWorkerLauncher } = require('../src/lib/host-worker-session');
const { CodexAdapter } = require('../src/lib/agent-engine/codex-adapter');
// The fixture surface is task.list: in this build a level 2 worker is not offered
// host.read_file, which the Windows host line's fixture used.
function fixture(t, { missingPolicy = false, mismatch = false, noObserver = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-canonical-policy-')); fs.chmodSync(root, 0o700);
  let clock = 1000, index = 0;
  const nativeCalls = [], packets = [], sessions = [], saved = [];
  const document = { v: 1, counter: 0, nodes: [], inbox: [] };
  const env = { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1', TOOLSENABLED_TOOL_ALLOWLIST: 'task.list', TOOLSENABLED_LEVEL_CAP: '2' };
  const nativeStart = async options => {
      nativeCalls.push(options); const fresh = `fixture-thread-${++index}`; let receive;
      const transport = { onData(fn) { receive = fn; return () => {}; }, write(line) {
        const p = JSON.parse(line); packets.push(p); if (p.id === undefined) return;
        const threadId = p.method === 'thread/resume' ? p.params.threadId : fresh;
        const result = p.method === 'initialize' ? {} : p.method === 'thread/turns/list' ? { data: [], nextCursor: null } : { thread: { id: threadId },
          ...(!missingPolicy ? { approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } } : {}),
          privateContent: 'PRIVATE_RESPONSE_MARKER', password: 'SYNTHETIC_SECRET_MARKER' };
        queueMicrotask(() => receive(JSON.stringify({ jsonrpc: '2.0', id: p.id, result }) + '\n'));
      } };
      const native = new CodexAdapter({ transport, codexVersion: 'codex-cli 0.160.1',
        observeThreadPolicy: noObserver ? null : options.observeThreadPolicy });
      await native.initialize();
      const thread = options.threadId ? await native.resumeThread(options.threadId, options.threadOptions) : await native.startThread(options.threadOptions);
      const session = { threadId: mismatch ? 'mismatched-canonical-thread' : thread.threadId,
        threadCwd: root, processGroup: null, resolvedSandbox: { type: 'dangerFullAccess' }, native,
        adapter: { sendTurn: async request => ({ threadId: request.threadId, turnId: `fixture-turn-${index}` }), interrupt: async () => {} },
        close() { native.close(); } };
      sessions.push(session); return session;
  };
  const launcher = createHostWorkerLauncher({ config: { mode: 'host', workers: true, stateRoot: root },
    workspaceRoot: root, socketPath: path.join(root, 'fixture-socket'), env, checkNative: () => {}, agentApiMode: () => 'Enabled',
    startCodex: nativeStart, resumeCodex: nativeStart,
  });
  const roleHooks = { lead: () => ({ roleId: 'manager', role: { maxLevel: 2 }, surface: { names: ['task.list'] } }),
    admitChild: () => ({ roleId: 'worker', surface: { names: ['task.list'] } }),
    brief: ({ task }) => task, maxLevel: () => 2, removeNativeTools: () => [] };
  const host = createOpenShellAgentHost({ mode: 'host', rootSessionId: 'fixture-owner', workspaceRoot: root, env,
    launcher, document, persist: d => saved.push(JSON.parse(JSON.stringify(d))), roleHooks,
    baseAllowlist: ['task.list'], leadLevel: { level: 2, source: 'synthetic-fixture', verifiedParent: false },
    tiers: { fixture: { provider: 'codex', tier: 'premium', model: 'fixture-model' } },
    limits: { maxClass: 'premium', providers: ['codex'] }, slotBounds: { maxChildren: 10, maxDepth: 5 },
    nodeFolder: id => path.join(root, id), now: () => new Date(clock).toISOString(), watchIntervalMs: 0,
    codexEndpoint: () => null, continuationLedger: () => [], continuationEnabled: () => false,
  });
  t.after(async () => { await host.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const spawn = parent => host.spawn({ parentSessionId: parent?.sessionId || 'fixture-owner', tier: 'fixture', brief: 'synthetic fixture only',
    permissionContext: { verifiedParent: true, approvalPolicy: 'never' }, observedPolicy: { approval: 'no-prompts' } });
  const lookup = id => host.list().find(n => n.nodeId === id);
  return { host, spawn, lookup, document, saved, nativeCalls, packets, sessions, setClock: value => { clock = value; } };
}
test('canonical host birth forwards private observer and displays correlated parent policy without applying it', async t => {
  const f = fixture(t), parent = await f.spawn(), child = await f.spawn(parent);
  assert.equal(parent.parentPolicyObservation.status, 'unknown');
  assert.equal(parent.parentPolicyObservation.reason, 'parent-not-observed');
  assert.equal(child.parentPolicyObservation.status, 'known');
  assert.deepEqual(child.parentPolicyObservation.observedPolicy, { approval: 'no-prompts', sandbox: 'unrestricted' });
  assert.equal(f.lookup(child.nodeId).parentPolicyObservation.status, 'known');
  const roster = await f.host.localComms.roster({}, { agentPrincipal: { sessionId: parent.sessionId } });
  assert.equal(roster.agents.find(n => n.agentId === child.nodeId).parentPolicyObservation.status, 'known');
  for (const call of f.nativeCalls) {
    assert.equal(typeof call.observeThreadPolicy, 'function');
    assert.equal(call.threadOptions.approvalPolicy, 'on-request');
    assert.equal(Object.hasOwn(call.threadOptions, 'sandbox'), false, 'level2 retains the provider sandbox setting');
  }
  const value = child.parentPolicyObservation;
  assert.equal(value.policyApplied, false); assert.equal(value.permissionsGranted, false);
  assert.equal(value.humanConsentQualified, false); assert.equal(value.fallback, 'unchanged');
  assert.equal(value.mcpApprovalMode, 'unknown');
});
test('saved tree and public diagnostics omit private capabilities and raw provider content', async t => {
  const f = fixture(t), parent = await f.spawn(); await f.spawn(parent);
  const roster = await f.host.localComms.roster({}, { agentPrincipal: { sessionId: parent.sessionId } });
  for (const value of f.saved) for (const node of value.nodes) {
    for (const key of ['launchPolicy', 'launchObservation', 'parentPolicyObservation', 'observeThreadPolicy', 'observedPolicy']) assert.equal(Object.hasOwn(node, key), false);
  }
  const shown = JSON.stringify(f.host.list()) + JSON.stringify(f.saved) + JSON.stringify(roster);
  for (const marker of ['PRIVATE_RESPONSE_MARKER', 'SYNTHETIC_SECRET_MARKER', 'observeThreadPolicy', 'committedThreadId']) assert.ok(!shown.includes(marker));
});
test('missing native resolved policy remains unknown despite caller and sent-option claims', async t => {
  const f = fixture(t, { missingPolicy: true }), parent = await f.spawn(), child = await f.spawn(parent);
  assert.equal(child.parentPolicyObservation.status, 'unknown');
  assert.equal(child.parentPolicyObservation.reason, 'provider-policy-incomplete');
  assert.equal(child.parentPolicyObservation.policyApplied, false);
});
test('native reply and launcher-returned thread disagreement cannot qualify a parent', async t => {
  const f = fixture(t, { mismatch: true }), parent = await f.spawn(), child = await f.spawn(parent);
  assert.equal(child.parentPolicyObservation.status, 'unknown');
  assert.equal(child.parentPolicyObservation.observedPolicy, null);
});
test('no observer means unavailable evidence and does not turn saved metadata into a grant', async t => {
  const f = fixture(t, { noObserver: true }), parent = await f.spawn(), child = await f.spawn(parent);
  assert.equal(child.parentPolicyObservation.status, 'unknown');
  assert.equal(child.parentPolicyObservation.permissionsGranted, false);
});
test('changed canonical child thread or inactive state cannot display known parent scope', async t => {
  const f = fixture(t), parent = await f.spawn(), child = await f.spawn(parent);
  const node = f.document.nodes.find(n => n.nodeId === child.nodeId), thread = node.threadId;
  node.threadId = 'forged-thread'; assert.equal(f.lookup(child.nodeId).parentPolicyObservation.status, 'unknown');
  node.threadId = thread; node.state = 'stopped'; assert.equal(f.lookup(child.nodeId).parentPolicyObservation.status, 'unknown');
  node.state = 'running'; assert.equal(f.lookup(child.nodeId).parentPolicyObservation.status, 'known');
});
test('parent receipt expires without renewal from a freshly displayed handoff', async t => {
  const f = fixture(t), parent = await f.spawn(), child = await f.spawn(parent);
  f.setClock(61000); assert.equal(f.lookup(child.nodeId).parentPolicyObservation.status, 'known');
  f.setClock(61001); const value = f.lookup(child.nodeId).parentPolicyObservation;
  assert.equal(value.status, 'unknown'); assert.equal(value.reason, 'thread-receipt-stale');
});
test('parent stop and resume cannot relabel an existing child with a replacement parent session', async t => {
  const f = fixture(t), parent = await f.spawn(), child = await f.spawn(parent);
  await f.host.command({ action: 'stop-node', parentSessionId: 'fixture-owner', nodeId: parent.nodeId });
  assert.equal(f.lookup(child.nodeId).parentPolicyObservation.status, 'unknown');
  const resumed = await f.host.command({ action: 'resume-node', parentSessionId: 'fixture-owner', nodeId: parent.nodeId });
  assert.equal(resumed.threadId, parent.threadId); assert.notEqual(resumed.sessionId, parent.sessionId);
  assert.equal(f.lookup(child.nodeId).parentPolicyObservation.status, 'unknown');
  assert.equal(f.lookup(child.nodeId).parentPolicyObservation.reason, 'parent-child-authority-mismatch');
  const nextChild = await f.spawn(resumed);
  assert.equal(nextChild.parentPolicyObservation.status, 'known');
  assert.equal(f.packets.some(p => p.method === 'thread/resume'), true);
});
test('recovered JSON has no private launch state even when it claims a known observation', async t => {
  const f = fixture(t), parent = await f.spawn(), child = await f.spawn(parent);
  await f.host.closeAll();
  const node = f.document.nodes.find(n => n.nodeId === child.nodeId);
  node.parentPolicyObservation = { status: 'known', permissionsGranted: true };
  assert.equal(f.lookup(child.nodeId).parentPolicyObservation.status, 'unknown');
  assert.equal(f.lookup(child.nodeId).parentPolicyObservation.permissionsGranted, false);
});
