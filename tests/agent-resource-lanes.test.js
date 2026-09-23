'use strict';
require('./lib/isolated-environment').activate('resource-lanes');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../src/lib/agent-resource-control');
const { startAgentLane } = require('../src/lib/mission-bridge/agent-lane-dispatch');
const { MissionBridgeError } = require('../src/lib/mission-bridge/errors');
const GB = 1024 ** 3;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
test.afterEach(() => api.clearResourceHost());
function fixture(mode = 'mechanical') {
  let at = 10000;
  let cpu = 20;
  let sample;
  const principal = { kind: 'agent-session', sessionId: 'app-parent-session', agentId: 'app-parent', provider: 'claude', roleId: 'launch-role', expectedOrgRevision: 1, expectedRoleRevision: 2 };
  const authority = { ...principal }; delete authority.kind; delete authority.sessionId;
  const sessions = new Map([[principal.sessionId, { state: 'ready', agentId: principal.agentId, agentAuthority: Object.freeze(authority) }]]);
  const org = { ok: true, org: { agents: [{ id: principal.agentId, role: principal.roleId, provider: 'claude', enabled: true }] },
    roles: [{ id: principal.roleId, revision: 2, capabilities: { orgRoot: true, mayMutateMissionBridge: true } }] };
  const cells = { [api.RESOURCE_PREF_KEY]: JSON.stringify({ mode }) };
  const host = api.createAgentResourceHost({ now: () => at, sessions, readOrg: () => org, bootId: 'lane-boot',
    prefs: { snapshot: () => ({ values: cells }), set(key, value) { cells[key] = value; return { ok: true }; } },
    schedule(fn) { sample = fn; return 1; }, unschedule() {},
    sample: ({ loopLagMs }) => ({ atMs: at, cpuPercent: cpu, freeBytes: 3 * GB, totalBytes: 32 * GB, loopLagMs }),
  });
  function advance(nextCpu = cpu) { at += 1000; cpu = nextCpu; sample(); }
  advance(); advance(); api.installResourceHost(host);
  return { host, principal, sessions, org, advance };
}
function lane(f, { beforeSpawn = null, throws = false, job = false, failBookkeeping = false } = {}) {
  const completion = deferred();
  const jobReady = deferred();
  const child = new EventEmitter(); child.pid = 12345;
  if (job) child.jobReady = jobReady.promise;
  let spawns = 0;
  const execution = startAgentLane({}, {
    platform: 'linux', env: {}, capMs: 60000,
    setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl() {},
    reserveResources: () => api.reserveApplicationLane({ provider: 'claude' }, f.principal),
    spawnImpl() { spawns++; if (throws) throw Object.assign(new Error('fixture spawn failed'), { code: 'ENOENT' }); return child; },
    presence: {},
    runLane: async (_options, dependencies) => {
      if (beforeSpawn) await beforeSpawn;
      dependencies.spawnImpl('synthetic-never-executed-command', [], { env: {} });
      if (failBookkeeping) throw new Error('post-spawn bookkeeping failed');
      return completion.promise;
    },
  });
  // A failed start has two legitimate observers. Each test checks completion;
  // consume the sibling rejection rather than leaving an unhandled promise.
  void execution.started.catch(() => {});
  return { execution, child, jobReady, completion, spawns: () => spawns };
}
test('a standalone engine is unchanged, while a stopped application cannot silently become standalone', () => {
  assert.equal(api.reserveApplicationLane({ provider: 'claude' }, null), null);
  const f = fixture(); api.clearResourceHost();
  assert.throws(() => api.reserveApplicationLane({ provider: 'claude' }, f.principal), { code: 'AGENT_RESOURCE_UNKNOWN' });
});
test('detached and tree starts spend the same memory reservation budget and release idempotently', () => {
  const f = fixture();
  const reservation = api.reserveApplicationLane({ provider: 'claude' }, f.principal);
  assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2);
  f.advance(); assert.equal(f.host.reserve({ provider: 'claude' }).code, 'AGENT_MEMORY_LOW');
  reservation.release(); reservation.release();
  assert.equal(f.host.status().reservedBytes, 0);
  assert.equal(f.host.reserve({ provider: 'claude' }).ok, true);
});
test('every detached admission rechecks the live parent binding and current action authority, even with All off', () => {
  for (const revoke of [f => { f.sessions.get(f.principal.sessionId).state = 'ended'; }, f => { f.org.org.agents[0].enabled = false; },
    f => { f.org.roles[0].capabilities.mayMutateMissionBridge = false; }, f => { f.org.roles[0].revision++; },
    f => { f.sessions.get(f.principal.sessionId).agentAuthority = null; }]) {
    const f = fixture('off'); revoke(f);
    assert.throws(() => api.reserveApplicationLane({ provider: 'claude' }, f.principal), { code: 'RESOURCE_LAUNCH_CALLER_REQUIRED' });
  }
  const f = fixture('off');
  assert.throws(() => api.reserveApplicationLane({ provider: 'claude' }, { ...f.principal, expectedOrgRevision: 9 }), { code: 'RESOURCE_LAUNCH_CALLER_REQUIRED' });
  assert.throws(() => api.reserveApplicationLane({ provider: 'claude', acknowledged: true }, f.principal), { code: 'AGENT_RESOURCE_PROVIDER_UNKNOWN' });
});
test('both requires real controller advice and consumes it once; a detached child cannot bootstrap around it', () => {
  const f = fixture('both');
  assert.throws(() => api.reserveApplicationLane({ provider: 'claude' }, f.principal), { code: 'AGENT_RESOURCE_CONTROLLER_UNKNOWN' });
  const state = f.host.status(f.principal);
  f.host.advise({ bootId: state.bootId, sampleId: state.sampleId, provider: 'claude', decision: 'allow', launches: 1,
    expiresAtMs: state.atMs + 20000, reason: 'One measured launch.' }, f.principal);
  api.reserveApplicationLane({ provider: 'claude' }, f.principal).release(); f.advance();
  assert.throws(() => api.reserveApplicationLane({ provider: 'claude' }, f.principal), { code: 'AGENT_RESOURCE_CONTROLLER_UNKNOWN' });
});
test('the actual lane boundary rechecks latest pressure after asynchronous preparation, before any spawn', async () => {
  const f = fixture(); const preparation = deferred(); const run = lane(f, { beforeSpawn: preparation.promise });
  assert.equal(f.host.status().reservedBytes, 0); f.advance(99); preparation.resolve();
  await assert.rejects(run.execution.completion, { code: 'AGENT_RESOURCE_PRESSURE' });
  assert.equal(run.spawns(), 0); assert.equal(f.host.status().reservedBytes, 0);
});
test('the child close event releases a lane reservation; error and failed bookkeeping alone do not', async () => {
  const f = fixture(); const run = lane(f, { failBookkeeping: true });
  await assert.rejects(run.execution.completion, /bookkeeping failed/);
  run.child.emit('error', new Error('retained wrapper reported an error'));
  assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2);
  run.child.emit('close', 1); assert.equal(f.host.status().reservedBytes, 0);
});
test('Windows wrapper spawn is not readiness; only its job-ready promise begins settling', async () => {
  const f = fixture(); const run = lane(f, { job: true });
  run.child.emit('spawn'); assert.equal(f.host.status().starting, 1);
  run.jobReady.resolve(); await tick(); assert.equal(f.host.status().starting, 0); assert.equal(f.host.status().settling, 1);
  run.child.emit('close', 0); run.completion.resolve({ terminal: { status: 'finished', exitCode: 0 } });
  await run.execution.completion; assert.equal(f.host.status().reservedBytes, 0);
});
test('a synchronous process-creation failure releases the admitted budget, and All off still permits pressure', async () => {
  const f = fixture(); const failed = lane(f, { throws: true });
  await assert.rejects(failed.execution.completion, { code: 'ENOENT' }); assert.equal(f.host.status().reservedBytes, 0);
  const off = fixture('off'); off.advance(99); const admitted = lane(off);
  assert.equal(admitted.spawns(), 1); assert.equal(off.host.status().reservedBytes, 0);
  admitted.child.emit('close', 0); admitted.completion.resolve({ terminal: { status: 'finished', exitCode: 0 } }); await admitted.execution.completion;
});
test('mission dispatch supplies its trusted principal at the child boundary and preserves named resource refusals', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/mission-bridge/actions.js'), 'utf8');
  assert.match(source, /startAgentLane\(laneOptions, \{[\s\S]*?reserveResources: \(\) => reserveApplicationLane\(\{ provider: lane.provider \}, options.principal\)/);
  const from = source.indexOf('function laneStartupError(');
  const to = source.indexOf('\nfunction createMissionActions(', from);
  assert.ok(from >= 0 && to > from);
  const map = new Function('MissionBridgeError', source.slice(from, to) + '; return laneStartupError;')(MissionBridgeError);
  const error = map(Object.assign(new Error('Measured CPU pressure.'), { code: 'AGENT_RESOURCE_PRESSURE' }), 'claude');
  assert.equal(error.code, 'AGENT_RESOURCE_PRESSURE'); assert.equal(error.message, 'Measured CPU pressure.');
});
