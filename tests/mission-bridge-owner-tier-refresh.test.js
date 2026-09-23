'use strict';
const isolated = require('./lib/isolated-environment').activate('mission-owner-tier-refresh');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
const policy = require('../src/lib/permission-tier-policy');

// These cases hold the required audit write open and change the permission
// during that await. Auditing is an explicit choice under the Basic runtime
// policy, so the isolated profile makes it the way a person does; without it
// no audit await exists to hold open. The final handler boundary revalidates
// either way, and one case below proves that with auditing not chosen.
let settingsRevision = 0;
function chooseAudit(enabled) {
  const isolatedRoot = isolated.root;
  const valuesPath = require('../src/lib/settings').resolveValuesPath();
  assert.ok(isolatedRoot && valuesPath.startsWith(isolatedRoot + path.sep), 'only the isolated profile is ever written');
  const values = { 'audit.enabled': enabled };
  fs.mkdirSync(path.dirname(valuesPath), { recursive: true });
  fs.writeFileSync(valuesPath, JSON.stringify({ revision: ++settingsRevision, values,
    provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user' }])), rejected: [] }));
  assert.equal(require('../src/lib/runtime-policy').runtimePolicy().auditEnabled, enabled, 'the isolated profile really holds that choice');
}
chooseAudit(true);

// Only audit persistence is held at a disposable test seam; the mission
// adapter, policy checks, registry dispatch, and lane boundaries are real.
let auditGate = null, auditWrites = 0;
const auditPath = require.resolve('../src/lib/coordinator-audit-events');
const coordinatorAudit = require(auditPath);
require.cache[auditPath].exports = { ...coordinatorAudit,
  writeAsync: async () => { auditWrites++; if (auditGate) await auditGate; return { durable: true }; },
  write: () => { auditWrites++; return { durable: true }; },
};
const admissionPath = require.resolve('../src/lib/audit-admission');
const admission = require(admissionPath);
require.cache[admissionPath].exports = { ...admission,
  defaultAdmissionQueue: () => ({ submit: async () => ({ durable: false }) }),
};
const registry = require('../src/lib/tool-registry');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { createOwnerPermissionScope } = require('../src/lib/mission-bridge/owner-permission-scope');
const laneDispatch = require('../src/lib/mission-bridge/agent-lane-dispatch');
const memory = require('../src/lib/providers/memory');
const { getStateStore, closeStateStore } = require('../src/lib/state-store');
test.after(() => closeStateStore());
let memoryWrites = 0;
memory.set = input => { memoryWrites++; return { namespace: input.namespace, key: input.key, revision: 1 }; };

function fixture(t, additions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-owner-tier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let record = { tier: 'unrestricted', createdAtMs: 1 };
  const machineRecord = { resolveServicesRoot: () => root,
    readMachineRecord: () => { if (record instanceof Error) throw record; return record; } };
  const options = { roots: { primary: root }, principal: { kind: 'owner-ui' }, agentOrg: declaredOrg(),
    machineRecord, policy: { assertActive() {} }, ...additions };
  return { options, machineRecord, set: value => { record = value; }, actions: createMissionActions(options) };
}
const reply = id => ({ idempotencyKey: id, threadId: 'fixture', message: 'Synthetic bounded note.' });
const changed = error => error?.code === 'BRIDGE_PERMISSION_CHANGED';

test('one cached real action adapter follows downgrade and fresh upgrade without restart', async t => {
  const sessions = [];
  const f = fixture(t, { executeTool: async (name, args, context) => {
    sessions.push(context.permissionSession);
    policy.assertToolAllowed(registry.getTool(name), context.permissionSession);
    return { namespace: args.namespace, key: args.key, revision: 1 };
  } });
  await f.actions.reply(reply('full'));
  f.set({ tier: 'guided', createdAtMs: 2 });
  await assert.rejects(f.actions.reply(reply('guided')), error => /^PERMISSION_/.test(error.code));
  f.set({ tier: 'unrestricted', createdAtMs: 3 });
  await f.actions.reply(reply('full-again'));
  assert.deepEqual(sessions.map(session => session.tier), ['full', 'confined', 'full']);
  f.set(new Error('Synthetic unreadable machine record.'));
  await assert.rejects(f.actions.reply(reply('unreadable')), error => /^PERMISSION_/.test(error.code));
});

test('a downgrade during the actual registry audit await prevents the memory handler', async t => {
  const f = fixture(t);
  let release;
  auditGate = new Promise(resolve => { release = resolve; });
  const before = memoryWrites;
  const pending = f.actions.reply(reply('audit-wait'));
  await new Promise(resolve => setImmediate(resolve));
  f.set({ tier: 'guided', createdAtMs: 2 });
  release();
  try { await assert.rejects(pending, changed); }
  finally { auditGate = null; }
  assert.equal(memoryWrites, before, 'no effect may cross the stale permission boundary');
});

test('with auditing not chosen a downgrade after admission is still refused at the final handler boundary', async t => {
  chooseAudit(false); t.after(() => chooseAudit(true));
  // Basic has no audit await to hold open, so the downgrade lands after the
  // action's own guard and permission snapshot and before the real registry
  // dispatch. Only the registry's final handler-boundary revalidation is left.
  const f = fixture(t, { executeTool: (name, args, context) => {
    f.set({ tier: 'guided', createdAtMs: 2 });
    return registry.executeTool(name, args, context);
  } });
  const before = memoryWrites, audited = auditWrites;
  await assert.rejects(f.actions.reply(reply('basic-no-audit')), changed);
  assert.equal(memoryWrites, before, 'no effect may cross the stale permission boundary without auditing either');
  assert.equal(auditWrites, audited, 'the refusal did not depend on any audit write');
});

test('concurrent owner calls retain independent snapshots; upgrade cannot refresh an older invocation', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { executeTool: async (name, args, context) => {
    if (args.key.endsWith('/old')) await wait;
    context.assertPermissionCurrent();
    return { namespace: args.namespace, key: args.key, revision: 1 };
  } });
  const old = f.actions.reply(reply('old'));
  f.set({ tier: 'guided', createdAtMs: 2 });
  f.set({ tier: 'unrestricted', createdAtMs: 3 });
  await f.actions.reply(reply('new'));
  release();
  await assert.rejects(old, changed);
});

test('explicit transport sessions keep their fixed ceiling instead of inheriting a machine upgrade', async t => {
  const supplied = { origin: 'local', tier: 'confined', profile: 'read-only' };
  const org = declaredOrg();
  const agent = org.agents.find(entry => entry.id === enabledControllerId(org));
  const agentPrincipal = { kind: 'agent-session', sessionId: 'fixture-agent', agentId: agent.id,
    provider: agent.provider, roleId: agent.role, expectedOrgRevision: org.revision, expectedRoleRevision: 1 };
  for (const principal of [{ kind: 'owner-ui' }, agentPrincipal]) {
    const f = fixture(t, { principal, permissionSession: supplied, executeTool: async (name, args, context) => {
      assert.equal(context.assertPermissionCurrent, undefined);
      policy.assertToolAllowed(registry.getTool(name), context.permissionSession);
    } });
    await assert.rejects(f.actions.reply(reply('fixed')), error => /^PERMISSION_/.test(error.code));
  }
});

test('downgrade during lane preparation refuses before OS spawn and releases the reservation', async t => {
  const f = fixture(t);
  const authority = createOwnerPermissionScope({ enabled: true, machineRecord: f.machineRecord });
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let spawned = 0, released = 0;
  const execution = authority.run(() => laneDispatch.startAgentLane({ agentId: 'fixture' }, {
    platform: 'linux', env: {}, assertPermissionCurrent: authority.assertCurrent,
    reserveResources: async () => { await wait; return { release: () => released++ }; },
    runLane: async (options, dependencies) => {
      await dependencies.beforeSpawn();
      return dependencies.spawnImpl('synthetic-command', [], {});
    },
    spawnImpl: () => { spawned++; return new EventEmitter(); },
  }));
  const refusedStart = assert.rejects(execution.started, changed);
  const refusedCompletion = assert.rejects(execution.completion, changed);
  f.set({ tier: 'guided', createdAtMs: 2 });
  release();
  await Promise.all([refusedStart, refusedCompletion]);
  assert.equal(spawned, 0);
  assert.equal(released, 1);
});

test('Windows provider-root handshake revalidates again after the wrapper has started', async t => {
  const f = fixture(t);
  const authority = createOwnerPermissionScope({ enabled: true, machineRecord: f.machineRecord });
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let roots = 0, wrappers = 0;
  const execution = authority.run(() => laneDispatch.startAgentLane({ agentId: 'fixture' }, {
    platform: 'win32', env: {}, assertPermissionCurrent: authority.assertCurrent,
    reserveResources: () => null,
    runLane: async (options, dependencies) => {
      await dependencies.beforeSpawn();
      const child = dependencies.spawnImpl('synthetic-command', [], {});
      await child.jobReady;
      return { terminal: { status: 'finished', exitCode: 0 } };
    },
    spawnInJobImpl: (command, args, options, hooks) => {
      wrappers++;
      const child = new EventEmitter();
      child.jobReady = (async () => {
        await wait;
        hooks.beforeRootSpawn();
        roots++;
      })();
      return child;
    },
  }));
  const refusedStart = assert.rejects(execution.started, changed);
  const refusedCompletion = assert.rejects(execution.completion, changed);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrappers, 1);
  f.set({ tier: 'guided', createdAtMs: 2 });
  release();
  await Promise.all([refusedStart, refusedCompletion]);
  assert.equal(roots, 0);
});

test('actual task submit and claim cannot mutate SQLite after a downgrade during admission', async t => {
  const f = fixture(t);
  const state = getStateStore();
  const input = { queue: 'owner-tier-fixture', type: 'fixture', idempotencyKey: 'submit-fixture', payload: { title: 'Synthetic task', objective: 'Synthetic metadata only.' }, expiryPolicy: 'retry', maxAttempts: 1 };
  for (const operation of ['submit', 'claim']) {
    f.set({ tier: 'standard', createdAtMs: operation === 'submit' ? 10 : 20 });
    if (operation === 'claim') state.submitTask(input);
    let release;
    auditGate = new Promise(resolve => { release = resolve; });
    const pending = operation === 'submit' ? f.actions.taskSubmit(input)
      : f.actions.taskClaim({ queue: input.queue, workerLabel: 'fixture', leaseSeconds: 30 });
    const refusal = assert.rejects(pending, changed);
    await new Promise(resolve => setImmediate(resolve));
    f.set({ tier: 'guided', createdAtMs: 30 });
    release();
    try { await refusal; }
    finally { auditGate = null; }
    const tasks = state.listTasks({ queue: input.queue });
    assert.equal(tasks.length, operation === 'submit' ? 0 : 1);
    if (tasks.length) assert.equal(tasks[0].status, 'queued', 'claim must not obtain a lease');
  }
});

test('authenticated HTTP owner requests reuse one adapter yet follow both live tier directions', async t => {
  const f = fixture(t, { executeTool: async (name, args, context) => {
    policy.assertToolAllowed(registry.getTool(name), context.permissionSession);
    return { namespace: args.namespace, key: args.key, revision: 1 };
  } });
  const { createMissionBridgeServer } = require('../src/lib/mission-bridge/server');
  const token = crypto.randomBytes(32);
  let factories = 0;
  const bridge = createMissionBridgeServer({ token, bootstrapProof: crypto.randomBytes(32),
    allowedOrigins: ['http://127.0.0.2:4600'], allowTestPortZero: true,
    runtimeFile: path.join(f.options.roots.primary, 'runtime.json'), allowTestRuntimeFile: true,
    runtimeDependencies: { platform: 'test' }, actionOptions: f.options,
    createActions: options => { factories++; return createMissionActions(options); },
  });
  t.after(() => bridge.close());
  const address = await bridge.listen(0);
  const request = async id => {
    const response = await fetch(`${address.baseUrl}/v1/actions/thread-reply`, {
      method: 'POST', headers: { origin: 'http://127.0.0.2:4600', authorization: `Bearer ${token.toString('base64url')}`, 'content-type': 'application/json' },
      body: JSON.stringify(reply(id)),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('first')).status, 200);
  f.set({ tier: 'guided', createdAtMs: 2 });
  const refused = await request('downgraded');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.code, /^PERMISSION_/);
  f.set({ tier: 'standard', createdAtMs: 3 });
  assert.equal((await request('upgraded')).status, 200);
  assert.equal(factories, 1, 'the test must exercise the real cached owner action instance');
});
