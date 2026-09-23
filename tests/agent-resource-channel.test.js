'use strict';
require('./lib/isolated-environment').activate('resource-channel');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { once } = require('node:events');
const api = require('../src/lib/agent-resource-control');
const { startAgentLane, laneChildEnvironment } = require('../src/lib/mission-bridge/agent-lane-dispatch');
const GB = 1024 ** 3;
const turn = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(mode = 'mechanical') {
  let at = 10000; let cpu = 20; let sample;
  const principal = { kind: 'agent-session', sessionId: 'root-session', agentId: 'root-agent', provider: 'claude', roleId: 'root-role', expectedOrgRevision: 1, expectedRoleRevision: 2 };
  const authority = { ...principal }; delete authority.kind; delete authority.sessionId;
  const sessions = new Map([[principal.sessionId, { state: 'ready', agentId: principal.agentId, agentAuthority: authority }]]);
  const org = { ok: true, org: { agents: [{ id: principal.agentId, role: principal.roleId, provider: 'claude', enabled: true }] },
    roles: [{ id: principal.roleId, revision: 2, capabilities: { orgRoot: true, mayMutateMissionBridge: true } }] };
  const cells = { [api.RESOURCE_PREF_KEY]: JSON.stringify({ mode }) };
  const host = api.createAgentResourceHost({ now: () => at, sessions, readOrg: () => org, bootId: 'host-boot',
    prefs: { snapshot: () => ({ values: cells }), set(key, value) { cells[key] = value; return { ok: true }; } },
    schedule(fn) { sample = fn; return 1; }, unschedule() {},
    sample: ({ loopLagMs }) => ({ atMs: at, cpuPercent: cpu, freeBytes: 3 * GB, totalBytes: 32 * GB, loopLagMs }),
  });
  const advance = (value = cpu) => { at += 1000; cpu = value; sample(); };
  advance(); advance();
  return { host, principal, sessions, org, advance, elapse(ms) { at += ms; } };
}
async function service(t, f, { grantDelay = 0, rootCheckDelay = 0, requestMs = 3000, beforeGrant = null } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-service-child-'));
  const canonical = fs.realpathSync(scratch);
  assert.ok(canonical.startsWith('C:\\Users\\ToolsEnabled-Dev\\') || process.platform !== 'win32');
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/resource-channel-child.js'), String(requestMs)], {
    cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { SystemRoot: process.env.SystemRoot, USERPROFILE: 'C:\\Users\\ToolsEnabled-Dev', TEMP: scratch, TMP: scratch,
      APPDATA: path.join(scratch, 'app-data'), LOCALAPPDATA: path.join(scratch, 'local-app-data'), TOOLSENABLED_STATE_ROOT: path.join(scratch, 'engine-state') },
  });
  let stdout = ''; let stderr = ''; let next = 0;
  const replies = new Map(); const events = new EventEmitter(); const observed = [];
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  child.on('message', value => {
    if (value?.channel !== 'fixture') return;
    if (value.id && replies.has(value.id)) { replies.get(value.id)(value); replies.delete(value.id); }
    if (value.event) { observed.push(value); events.emit(value.event, value); }
  });
  if (grantDelay || rootCheckDelay || beforeGrant) {
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      if (message.channel === api.CHANNEL && message.grantId) {
        beforeGrant?.();
        setTimeout(() => originalSend(message, callback), grantDelay);
        return true;
      }
      if (message.channel === api.CHANNEL && message.expiresAtMs && !message.grantId) { setTimeout(() => originalSend(message, callback), rootCheckDelay); return true; }
      return originalSend(message, callback);
    };
  }
  const channel = api.attachResourceAuthority(child, { reserveLane: (request, principal) => f.host.reserveServiceLane(request, principal),
    onUnavailable: listener => f.host.onUnavailable(listener) });
  t.after(async () => {
    channel.close();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill(); await closed;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  await Promise.race([once(events, 'ready'), delay(4000).then(() => { throw new Error(`Fixture did not connect: ${stderr}`); })]);
  const call = value => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { replies.delete(id); reject(new Error(`Fixture request timed out: ${value.op} ${stderr}`)); }, 5000);
    replies.set(id, answer => { clearTimeout(timer); resolve(answer); });
    child.send({ channel: 'fixture', id, ...value });
  });
  return { child, channel, call, events, observed, stdout: () => stdout };
}

test('two real service processes and tree starts spend one atomic app budget', async t => {
  const f = fixture(); const a = await service(t, f); const b = await service(t, f);
  const answers = await Promise.all([a.call({ op: 'reserve' }), b.call({ op: 'reserve' })]);
  assert.equal(answers.filter(value => value.ok).length, 1);
  assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2);
  f.advance(); assert.equal(f.host.reserve({ provider: 'claude' }).code, 'AGENT_MEMORY_LOW');
  const winner = answers[0].ok ? a : b; const grant = answers.find(value => value.ok);
  await winner.call({ op: 'release', leaseId: grant.result.leaseId }); await delay(20);
  assert.equal(f.host.status().reservedBytes, 0);
});

test('real IPC rejects duplicate sequence, wrong boot, and caller acknowledgement without spending capacity', async t => {
  const f = fixture(); const s = await service(t, f); const bootId = s.channel.snapshot().bootId;
  const base = { channel: api.CHANNEL, type: 'request', sequence: 1, op: 'reserve', bootId, provider: 'claude', principal: { kind: 'owner-ui' } };
  assert.equal((await s.call({ op: 'raw', value: base })).result.code, 'RESOURCE_CHANNEL_REPLAY');
  assert.equal((await s.call({ op: 'raw', value: { ...base, sequence: 900, bootId: 'other-boot' } })).result.code, 'AGENT_RESOURCE_UNKNOWN');
  assert.equal((await s.call({ op: 'raw', value: { ...base, sequence: 901, acknowledged: true } })).result.code, 'RESOURCE_LAUNCH_CALLER_REQUIRED');
  assert.equal(f.host.status().reservedBytes, 0);
});

test('real service agent reservations require the exact current app session binding, including All off', async t => {
  const f = fixture('off'); const s = await service(t, f);
  assert.equal((await s.call({ op: 'reserve', principal: { ...f.principal, expectedOrgRevision: 99 } })).code, 'RESOURCE_LAUNCH_CALLER_REQUIRED');
  f.sessions.get(f.principal.sessionId).state = 'ended';
  assert.equal((await s.call({ op: 'reserve', principal: f.principal })).code, 'RESOURCE_LAUNCH_CALLER_REQUIRED');
  assert.equal((await s.call({ op: 'reserve', principal: { kind: 'owner-ui', acknowledged: true } })).code, 'RESOURCE_LAUNCH_CALLER_REQUIRED');
  assert.equal((await s.call({ op: 'reserve' })).ok, true);
  f.host.dispose(); assert.equal((await s.call({ op: 'reserve' })).code, 'AGENT_RESOURCE_UNKNOWN');
});

test('a real service direct-root launch revalidates an unexpired grant before starting a harmless process', async t => {
  for (const revoked of [false, true]) {
    const f = fixture('off');
    const s = await service(t, f, { beforeGrant() { if (revoked) f.sessions.get(f.principal.sessionId).state = 'ended'; } });
    const answer = await s.call({ op: 'direct-lane', principal: f.principal });
    if (revoked) {
      assert.equal(answer.code, 'RESOURCE_LAUNCH_CALLER_REQUIRED');
      assert.equal(s.observed.filter(value => value.event === 'direct-root-spawned').length, 0);
    } else {
      assert.equal(answer.ok, true, answer.message);
      assert.equal(answer.result.code, 0, answer.result.errors);
      assert.equal(answer.result.output, 'harmless-direct-root\n');
      assert.equal(s.observed.filter(value => value.event === 'direct-root-spawned').length, 1);
    }
    await delay(20);
    assert.equal(s.channel.snapshot().active, 0);
  }
});

test('Both and controller-only owner lanes hold without advice; one real controller budget cannot be replayed', async t => {
  for (const mode of ['both', 'controller']) {
    const f = fixture(mode); const s = await service(t, f);
    assert.equal((await s.call({ op: 'reserve' })).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
    const status = f.host.status(f.principal);
    f.host.advise({ bootId: status.bootId, sampleId: status.sampleId, provider: 'claude', decision: 'allow', launches: 1,
      expiresAtMs: status.atMs + 10000, reason: 'One fixture launch.' }, f.principal);
    const first = await s.call({ op: 'reserve' }); assert.equal(first.ok, true);
    await s.call({ op: 'release', leaseId: first.result.leaseId }); await delay(20); f.advance();
    assert.equal((await s.call({ op: 'reserve' })).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
  }
});

test('a late real IPC grant is refused at the immediate spawn boundary and then cancelled', async t => {
  const f = fixture('controller'); const s = await service(t, f, { grantDelay: 150 });
  const status = f.host.status(f.principal);
  f.host.advise({ bootId: status.bootId, sampleId: status.sampleId, provider: 'claude', decision: 'allow', launches: 1,
    expiresAtMs: status.atMs + 100, reason: 'Short original advice cannot be extended by delayed transport.' }, f.principal);
  const grant = await s.call({ op: 'reserve' }); assert.equal(grant.ok, true);
  assert.equal((await s.call({ op: 'spawn', leaseId: grant.result.leaseId })).code, 'AGENT_RESOURCE_GRANT_EXPIRED');
  await delay(20); assert.equal(f.host.status().reservedBytes, 0); assert.equal(s.observed.some(value => value.event === 'spawned'), false);
});

test('a healthy on-time Windows OWNER handshake starts one harmless contained root, not just its wrapper', { skip: process.platform !== 'win32' && 'requires a native Windows Job Object and OWNER pipe', timeout: 15000 }, async t => {
  const f = fixture(); const s = await service(t, f);
  const grant = await s.call({ op: 'reserve' }); assert.equal(grant.ok, true);
  const closed = once(s.events, 'closed');
  assert.equal((await s.call({ op: 'windows-job', leaseId: grant.result.leaseId })).ok, true);
  const [result] = await closed;
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.output, 'harmless-root-started\n');
  assert.equal(s.observed.filter(value => value.event === 'root-check').length, 1);
  assert.equal(s.observed.filter(value => value.event === 'root-permitted').length, 1);
  assert.equal(s.observed.filter(value => value.event === 'root-ready').length, 1);
  assert.deepEqual(s.observed.find(value => value.event === 'job-outcome')?.outcome, { type: 'exit', exitCode: 0, activeProcesses: 0 });
  await delay(20); assert.equal(f.host.status().reservedBytes, 0);
});

test('a delayed Windows wrapper cannot start its provider root after the original sample expired', { skip: process.platform !== 'win32' && 'requires a native Windows Job Object and OWNER pipe', timeout: 15000 }, async t => {
  const f = fixture();
  assert.equal(f.host.configure({ mode: 'mechanical', sampleMaxAgeMs: 2500 }).ok, true);
  const s = await service(t, f);
  const grant = await s.call({ op: 'reserve' }); assert.equal(grant.ok, true);
  assert.equal(grant.result.admission.validForMs, 2500);
  const refused = once(s.events, 'root-refused'); const closed = once(s.events, 'closed');
  assert.equal((await s.call({ op: 'windows-job', leaseId: grant.result.leaseId, wrapperDelayMs: 2800 })).ok, true);
  // The wrapper is actually alive, so release remains charged during the wait.
  await s.call({ op: 'release', leaseId: grant.result.leaseId }); await delay(30);
  assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2);
  assert.equal((await refused)[0].code, 'AGENT_RESOURCE_GRANT_EXPIRED');
  const [result] = await closed;
  assert.equal(result.output, '');
  assert.equal(s.observed.some(value => value.event === 'root-permitted' || value.event === 'root-ready'), false);
  await delay(20);
  assert.equal(s.observed.find(value => value.event === 'job-outcome')?.outcome.type, 'not-started');
  assert.equal(s.observed.find(value => value.event === 'job-outcome')?.outcome.activeProcesses, 0);
  assert.equal(f.host.status().reservedBytes, 0, 'only observed wrapper close plus non-launch proof releases the charge');
});

test('a real service disconnect while its Windows wrapper warms refuses OWNER and never fabricates a release receipt', { skip: process.platform !== 'win32' && 'requires a native Windows Job Object and OWNER pipe', timeout: 15000 }, async t => {
  const f = fixture(); const s = await service(t, f);
  const grant = await s.call({ op: 'reserve' }); assert.equal(grant.ok, true);
  const disconnected = once(s.child, 'disconnect'); const closed = once(s.child, 'close');
  assert.equal((await s.call({ op: 'windows-job', leaseId: grant.result.leaseId, wrapperDelayMs: 500, disconnectBeforeOwner: true })).ok, true);
  await disconnected; await closed;
  assert.match(s.stdout(), /WINDOWS_DISCONNECTED_RESULT .*"output":"","refusal":"AGENT_RESOURCE_GRANT_EXPIRED"/);
  assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2, 'the app cannot observe a cleanup receipt after IPC disconnect');
});

test('one grant permits only one wrapper and one provider-root check', async t => {
  const f = fixture(); const s = await service(t, f);
  const grant = await s.call({ op: 'reserve' }); const leaseId = grant.result.leaseId;
  assert.equal((await s.call({ op: 'consume', leaseId })).ok, true);
  assert.equal((await s.call({ op: 'root-check', leaseId })).ok, true);
  assert.equal((await s.call({ op: 'root-check', leaseId })).code, 'RESOURCE_CHANNEL_GRANT_USED');
  assert.equal((await s.call({ op: 'consume', leaseId })).code, 'RESOURCE_CHANNEL_GRANT_USED');
  await s.call({ op: 'release', leaseId }); await delay(20);
  assert.equal(f.host.status().reservedBytes, 0);
});

test('disposing the monitor revokes an unexpired grant on the still-living service connection', async t => {
  const f = fixture(); const s = await service(t, f);
  const grant = await s.call({ op: 'reserve' }); const leaseId = grant.result.leaseId;
  assert.equal((await s.call({ op: 'consume', leaseId })).ok, true);
  f.host.dispose();
  assert.equal(s.child.connected, true, 'the service is deliberately still alive');
  assert.equal((await s.call({ op: 'root-check', leaseId })).code, 'AGENT_RESOURCE_GRANT_EXPIRED');
  assert.equal((await s.call({ op: 'reserve' })).code, 'AGENT_RESOURCE_UNKNOWN');
  assert.equal(s.channel.snapshot().active, 1, 'revocation is not a fabricated cleanup receipt');
});

test('new adverse evidence after wrapper admission is checked in the app before actual Windows OWNER', { skip: process.platform !== 'win32' && 'requires a native Windows Job Object and OWNER pipe', timeout: 20000 }, async t => {
  const cases = [
    { mode: 'mechanical', code: 'AGENT_RESOURCE_PRESSURE', change: f => f.advance(99) },
    { mode: 'both', code: 'AGENT_RESOURCE_CONTROLLER_HOLD', change: f => {
      f.advance(); const state = f.host.status(f.principal);
      f.host.advise({ bootId: state.bootId, sampleId: state.sampleId, provider: 'claude', decision: 'hold', launches: 0,
        expiresAtMs: state.atMs + 10000, reason: 'Stop the pending fixture root.' }, f.principal);
    } },
    { mode: 'both', code: 'AGENT_RESOURCE_CONTROLLER_UNKNOWN', change: f => { f.org.roles[0].capabilities.orgRoot = false; } },
    { mode: 'off', code: 'RESOURCE_LAUNCH_CALLER_REQUIRED', agent: true, change: f => { f.sessions.get(f.principal.sessionId).state = 'ended'; } },
  ];
  for (const scenario of cases) {
    const f = fixture(scenario.mode); const s = await service(t, f);
    if (scenario.mode === 'both') {
      const state = f.host.status(f.principal);
      f.host.advise({ bootId: state.bootId, sampleId: state.sampleId, provider: 'claude', decision: 'allow', launches: 1,
        expiresAtMs: state.atMs + 10000, reason: 'One original fixture allowance.' }, f.principal);
    }
    const grant = await s.call({ op: 'reserve', ...(scenario.agent ? { principal: f.principal } : {}) });
    assert.equal(grant.ok, true, scenario.code);
    const refused = once(s.events, 'root-refused'); const closed = once(s.events, 'closed');
    assert.equal((await s.call({ op: 'windows-job', leaseId: grant.result.leaseId, wrapperDelayMs: 300 })).ok, true);
    scenario.change(f);
    assert.equal((await refused)[0].code, scenario.code);
    assert.equal((await closed)[0].output, '', scenario.code);
    assert.equal(s.observed.some(value => value.event === 'root-permitted' || value.event === 'root-ready'), false);
    await delay(20);
    assert.equal(f.host.status().reservedBytes, 0);
  }
});

test('a delayed final IPC revalidation reply cannot permit OWNER after its bounded request timed out', { skip: process.platform !== 'win32' && 'requires a native Windows Job Object and OWNER pipe', timeout: 15000 }, async t => {
  const f = fixture(); const s = await service(t, f, { rootCheckDelay: api.ROOT_CHECK_MS + 70 });
  const grant = await s.call({ op: 'reserve' }); assert.equal(grant.ok, true);
  const refused = once(s.events, 'root-refused'); const closed = once(s.events, 'closed');
  assert.equal((await s.call({ op: 'windows-job', leaseId: grant.result.leaseId })).ok, true);
  assert.equal((await refused)[0].code, 'AGENT_RESOURCE_UNKNOWN');
  assert.equal((await closed)[0].output, '');
  await delay(100);
  assert.equal(s.observed.some(value => value.event === 'root-permitted'), false);
  assert.equal(f.host.status().reservedBytes, 0);
});

test('a grant arriving after the request timed out never resurrects the request or leaks its unused reservation', async t => {
  const f = fixture(); const s = await service(t, f, { grantDelay: 150, requestMs: 60 });
  assert.equal((await s.call({ op: 'reserve' })).code, 'AGENT_RESOURCE_UNKNOWN');
  await delay(200); assert.equal(f.host.status().reservedBytes, 0); assert.equal(s.observed.some(value => value.event === 'spawned'), false);
});

test('disconnect immediately before spawn refuses; disconnect alone never releases possibly consumed capacity', async t => {
  const f = fixture(); const s = await service(t, f);
  const grant = await s.call({ op: 'reserve' }); assert.equal(grant.ok, true);
  const disconnected = once(s.child, 'disconnect');
  s.child.send({ channel: 'fixture', op: 'disconnect-then-consume', leaseId: grant.result.leaseId });
  await disconnected; await delay(30);
  assert.match(s.stdout(), /AGENT_RESOURCE_GRANT_EXPIRED/);
  assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2);
});

test('a grant cannot be consumed twice and a living harmless child cannot release its reservation', async t => {
  const f = fixture(); const s = await service(t, f);
  const grant = await s.call({ op: 'reserve' }); const leaseId = grant.result.leaseId;
  const closed = once(s.events, 'closed');
  assert.equal((await s.call({ op: 'spawn', leaseId })).ok, true);
  assert.equal((await s.call({ op: 'consume', leaseId })).code, 'RESOURCE_CHANNEL_GRANT_USED');
  await s.call({ op: 'release', leaseId }); await delay(20);
  assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2);
  assert.equal((await closed)[0].code, 0, 'the real child inherited neither IPC descriptor nor send capability');
  await delay(20); assert.equal(f.host.status().reservedBytes, 0);
});

test('an unproven Windows job outcome remains charged even after the retained wrapper reports close', async t => {
  const f = fixture(); const s = await service(t, f);
  const grant = await s.call({ op: 'reserve' });
  const closed = once(s.events, 'closed');
  assert.equal((await s.call({ op: 'spawn', leaseId: grant.result.leaseId, unprovenJob: true })).ok, true);
  assert.equal((await closed)[0].code, 0); await delay(20);
  assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2);
  assert.equal(s.channel.snapshot().active, 1);
});

test('stale or pressured monitor holds service starts, while All off disables those policy checks only', async t => {
  const f = fixture(); const s = await service(t, f);
  f.elapse(7000);
  assert.equal((await s.call({ op: 'reserve' })).code, 'AGENT_RESOURCE_UNKNOWN');
  f.advance(99);
  assert.equal((await s.call({ op: 'reserve' })).code, 'AGENT_RESOURCE_PRESSURE');
  f.host.configure({ mode: 'off' });
  assert.equal((await s.call({ op: 'reserve' })).ok, true);
  f.host.dispose();
  assert.equal((await s.call({ op: 'reserve' })).code, 'AGENT_RESOURCE_UNKNOWN');
});

test('the host reports sample validity and the transport cannot extend a shorter controller expiry', async t => {
  const measured = fixture();
  const measuredLease = measured.host.reserveServiceLane({ provider: 'claude' }, { kind: 'owner-ui' });
  assert.equal(measuredLease.admission.validForMs, 6000); measuredLease.release();
  const f = fixture('controller'); const s = await service(t, f);
  const status = f.host.status(f.principal);
  f.host.advise({ bootId: status.bootId, sampleId: status.sampleId, provider: 'claude', decision: 'allow', launches: 1,
    expiresAtMs: status.atMs + 100, reason: 'Very short finite advice.' }, f.principal);
  const grant = await s.call({ op: 'reserve' }); assert.equal(grant.ok, true);
  await delay(130);
  assert.equal((await s.call({ op: 'spawn', leaseId: grant.result.leaseId })).code, 'AGENT_RESOURCE_GRANT_EXPIRED');
  await delay(20); assert.equal(f.host.status().reservedBytes, 0);
});

test('the actual app-owned service CLI refuses a missing inherited channel before listening or minting a bearer', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-cli-no-channel-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const stateRoot = path.join(scratch, 'local-app-data', 'ToolsEnabled Resource Fixture', 'capability');
  const child = spawn(process.execPath, [path.join(__dirname, '../tools/mission-bridge.js'),
    '--origin', 'http://127.0.0.1:4603', '--root', `main=${scratch}`, '--resource-channel', 'inherited'], {
    cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { SystemRoot: process.env.SystemRoot, USERPROFILE: 'C:\\Users\\ToolsEnabled-Dev', TEMP: scratch, TMP: scratch,
      APPDATA: path.join(scratch, 'app-data'), LOCALAPPDATA: path.join(scratch, 'local-app-data'), TOOLSENABLED_STATE_ROOT: stateRoot },
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const deadline = setTimeout(() => child.kill(), 5000);
  const [code] = await once(child, 'close'); clearTimeout(deadline);
  assert.equal(code, 1, stderr); assert.equal(stdout, ''); assert.match(stderr, /AGENT_RESOURCE_UNKNOWN/);
  assert.equal(fs.existsSync(path.join(stateRoot, 'state', 'mission-bridge-token.json')), false);
  assert.equal(fs.existsSync(path.join(stateRoot, 'state', 'mission-bridge-bootstrap-proof.json')), false);
});

test('async preparation is awaited before the canonical boundary and no descriptor survives environment composition', async () => {
  let admit; let calls = 0; let released = 0;
  const child = new EventEmitter();
  const start = startAgentLane({}, { env: {}, platform: 'linux', capMs: 10000, presence: {},
    reserveResources: () => new Promise(resolve => { admit = resolve; }),
    spawnImpl() { calls++; return child; },
    setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl() {},
    runLane: async (_options, dependencies) => { await dependencies.beforeSpawn(); dependencies.spawnImpl('never-a-provider', [], { env: {} }); return {}; },
  });
  assert.equal(calls, 0);
  admit({ beforeSpawn() {}, release() { released++; } });
  await start.completion; assert.equal(calls, 1); assert.equal(released, 0);
  child.emit('close', 0); assert.equal(released, 1);
  assert.deepEqual(laneChildEnvironment({ NODE_CHANNEL_FD: '3', node_channel_serialization_mode: 'json' }, {}), {});
});

test('the canonical Windows lane adapter passes the same spent reservation to the later OWNER boundary', async () => {
  const phases = []; let hook; const child = new EventEmitter();
  const reservation = { beforeSpawn() { phases.push('wrapper'); }, spawned(value) { assert.equal(value, child); phases.push('retained'); },
    beforeRootSpawn() { phases.push('root'); }, release() {}, ready() {} };
  const run = startAgentLane({}, { env: {}, platform: 'win32', capMs: 1000, presence: {},
    reserveResources: async () => { phases.push('debit'); return reservation; },
    spawnInJobImpl(_command, _args, _options, dependencies) { hook = dependencies.beforeRootSpawn; return child; },
    setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl() {},
    runLane: async (_options, dependencies) => { await dependencies.beforeSpawn(); dependencies.spawnImpl('never-a-provider', [], { env: {} }); return {}; },
  });
  await run.completion;
  assert.deepEqual(phases, ['debit', 'wrapper', 'retained']);
  hook(); assert.deepEqual(phases, ['debit', 'wrapper', 'retained', 'root']);
});
