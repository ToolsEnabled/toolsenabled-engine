'use strict';
require('./lib/isolated-environment').activate('resource-direct-root');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const api = require('../src/lib/agent-resource-control');
const { startAgentLane } = require('../src/lib/mission-bridge/agent-lane-dispatch');

test('closing a resource client removes only its listeners, rejecting pending work without closing shared IPC', async () => {
  const peer = new EventEmitter();
  peer.connected = true;
  peer.send = () => true;
  peer.disconnect = () => assert.fail('a resource client does not own the shared transport');
  const unrelated = () => {};
  peer.on('message', unrelated); peer.on('disconnect', unrelated);
  const client = api.createResourceClient({ peer });
  const connecting = assert.rejects(client.connect(), { code: 'AGENT_RESOURCE_UNKNOWN' });
  client.close(); client.close();
  await connecting;
  assert.deepEqual(peer.listeners('message'), [unrelated]);
  assert.deepEqual(peer.listeners('disconnect'), [unrelated]);
  assert.equal(peer.connected, true);
  await assert.rejects(client.connect(), { code: 'AGENT_RESOURCE_UNKNOWN' });
});
const GB = 1024 ** 3;
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(mode = 'mechanical') {
  let at = 10000; let cpu = 20; let sample;
  const principal = { kind: 'agent-session', sessionId: 'parent-session', agentId: 'parent-agent', provider: 'claude', roleId: 'parent-role', expectedOrgRevision: 1, expectedRoleRevision: 2 };
  const authority = { ...principal }; delete authority.kind; delete authority.sessionId;
  const sessions = new Map([[principal.sessionId, { state: 'ready', agentId: principal.agentId, agentAuthority: authority }]]);
  const org = { ok: true, org: { agents: [{ id: principal.agentId, role: principal.roleId, provider: 'claude', enabled: true }] },
    roles: [{ id: principal.roleId, revision: 2, capabilities: { orgRoot: true, mayMutateMissionBridge: true } }] };
  const cells = { [api.RESOURCE_PREF_KEY]: JSON.stringify({ mode }) };
  const host = api.createAgentResourceHost({ now: () => at, sessions, readOrg: () => org, bootId: 'direct-root-boot',
    prefs: { snapshot: () => ({ values: cells }), set(key, value) { cells[key] = value; return { ok: true }; } },
    schedule(fn) { sample = fn; return 1; }, unschedule() {},
    sample: ({ loopLagMs }) => ({ atMs: at, cpuPercent: cpu, freeBytes: 3 * GB, totalBytes: 32 * GB, loopLagMs }),
  });
  // With resource limits Off the host schedules no sampler at all (Basic runtime policy), so there is nothing to tick.
  const advance = (value = cpu) => { at += 1000; cpu = value; if (mode === 'off') assert.equal(sample, undefined, 'Off keeps no sampler'); else sample(); };
  const advise = (decision = 'allow', lifetimeMs = 10000) => {
    const status = host.status(principal);
    assert.equal(host.advise({ bootId: status.bootId, sampleId: status.sampleId, provider: 'claude', decision,
      launches: decision === 'allow' ? 1 : 0, expiresAtMs: at + lifetimeMs, reason: 'One bounded fixture root.' }, principal).ok, true);
  };
  advance(); advance();
  return { host, principal, sessions, advance, advise, now: () => at, elapse(ms) { at += ms; } };
}

// The real dispatcher, client, authority and governor run on both sides of an
// asynchronous paired transport. Only OS process creation is a stand-in. No
// provider, credentials, account config, or owner state is opened by this test.
function lane(t, f, { platform = 'linux', afterGrant = () => {}, afterPreparation = () => {}, duplicate = false,
  clientTiming = {}, authorityNow = f.now, deliverReply = (_value, deliver) => deliver() } = {}) {
  const app = new EventEmitter(); const service = new EventEmitter();
  app.connected = service.connected = true;
  const operations = [];
  app.send = (value, callback) => {
    if (value.channel === api.CHANNEL && value.ok === true && value.grantId) afterGrant();
    deliverReply(value, () => queueMicrotask(() => { service.emit('message', value); callback?.(null); }));
    return true;
  };
  service.send = (value, callback) => {
    operations.push(value.op);
    queueMicrotask(() => { app.emit('message', value); callback?.(null); });
    return true;
  };
  const channel = api.attachResourceAuthority(app, { now: authorityNow, reserveLane: (request, principal) => f.host.reserveServiceLane(request, principal) });
  const client = api.createResourceClient({ peer: service, now: f.now, monotonic: f.now, ...clientTiming });
  t.after(() => { client.close(); channel.close(); f.host.dispose(); });
  const child = new EventEmitter(); child.pid = 12345;
  let roots = 0;
  const execution = startAgentLane({}, { env: {}, platform, capMs: 1000, presence: {},
    reserveResources: () => client.reserveLane({ provider: 'claude' }, f.principal),
    spawnImpl() { roots++; return child; },
    setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl() {},
    runLane: async (_options, dependencies) => {
      await dependencies.beforeSpawn();
      afterPreparation({ client, service });
      dependencies.spawnImpl('never-an-executable', [], { env: {} });
      if (duplicate) assert.throws(() => dependencies.spawnImpl('never-an-executable', [], { env: {} }), { code: 'AGENT_RESOURCE_GRANT_USED' });
      return {};
    },
  });
  void execution.started.catch(() => {});
  return { execution, operations, child, channel, roots: () => roots };
}

test('Linux and macOS direct roots revalidate once, keep one debit, and release only on close', async t => {
  for (const platform of ['linux', 'darwin']) {
    const f = fixture('both'); f.advise();
    const run = lane(t, f, { platform, duplicate: true });
    await run.execution.completion;
    assert.equal(run.roots(), 1);
    assert.equal(run.operations.filter(op => op === 'reserve').length, 1);
    assert.equal(run.operations.filter(op => op === 'revalidate').length, 1);
    assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2, 'the final check does not charge a second 768 MiB');
    assert.equal(f.host.status().controller.claude.remaining, 0, 'the single controller credit is not refilled or charged twice');
    run.child.emit('spawn'); await turn();
    assert.equal(f.host.status().settling, 1);
    run.child.emit('error', new Error('not a cleanup receipt'));
    assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2);
    run.child.emit('close', 0); await turn();
    assert.equal(f.host.status().reservedBytes, 0);
    assert.equal(run.channel.snapshot().active, 0);
  }
});

test('revoking the parent before delivery of an unexpired Off grant prevents every direct root', async t => {
  for (const platform of ['linux', 'darwin']) {
    const f = fixture('off');
    const run = lane(t, f, { platform, afterGrant() { f.sessions.get(f.principal.sessionId).state = 'ended'; } });
    await assert.rejects(run.execution.completion, { code: 'RESOURCE_LAUNCH_CALLER_REQUIRED' });
    await turn();
    assert.equal(run.roots(), 0);
    assert.equal(run.operations.filter(op => op === 'revalidate').length, 1);
    assert.equal(run.channel.snapshot().active, 0, 'a refused preparation with no child cancels its unused reservation');
  }
});

test('new pressure or a controller hold after admission prevents an otherwise unexpired direct root', async t => {
  for (const mode of ['mechanical', 'controller', 'both']) {
    const f = fixture(mode); if (mode !== 'mechanical') f.advise();
    const run = lane(t, f, { afterGrant() { if (mode === 'mechanical') f.advance(99); else { f.advance(); f.advise('hold'); } } });
    await assert.rejects(run.execution.completion, { code: mode === 'mechanical' ? 'AGENT_RESOURCE_PRESSURE' : 'AGENT_RESOURCE_CONTROLLER_HOLD' });
    await turn();
    assert.equal(run.roots(), 0);
    assert.equal(f.host.status().reservedBytes, 0);
    assert.equal(run.channel.snapshot().active, 0);
  }
});

test('the final direct-root boundary synchronously checks expiry after awaited revalidation', async t => {
  const f = fixture();
  const run = lane(t, f, { afterPreparation() { f.elapse(5000); } });
  await assert.rejects(run.execution.completion, { code: 'AGENT_RESOURCE_GRANT_EXPIRED' });
  await turn();
  assert.equal(run.operations.filter(op => op === 'revalidate').length, 1);
  assert.equal(run.roots(), 0);
  assert.equal(f.host.status().reservedBytes, 0);
});

test('disconnect after awaited direct-root revalidation prevents spawn without inventing a remote release', async t => {
  const f = fixture();
  const run = lane(t, f, { afterPreparation({ client, service }) { client.close(); service.connected = false; } });
  await assert.rejects(run.execution.completion, { code: 'AGENT_RESOURCE_GRANT_EXPIRED' });
  await turn();
  assert.equal(run.operations.filter(op => op === 'revalidate').length, 1);
  assert.equal(run.roots(), 0);
  assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2, 'the app has no cleanup receipt after channel loss');
  assert.equal(run.channel.snapshot().active, 1);
});

test('in-process direct roots also revalidate exact live authority at the final synchronous boundary', async t => {
  const f = fixture('off'); t.after(() => f.host.dispose());
  let roots = 0;
  const run = startAgentLane({}, { env: {}, platform: 'linux', capMs: 1000, presence: {},
    reserveResources() {
      const lease = f.host.reserveLane({ provider: 'claude' }, f.principal);
      f.sessions.get(f.principal.sessionId).state = 'ended';
      return lease;
    },
    spawnImpl() { roots++; return new EventEmitter(); },
    setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl() {},
    runLane: async (_options, dependencies) => { await dependencies.beforeSpawn(); dependencies.spawnImpl('never-an-executable', [], { env: {} }); return {}; },
  });
  void run.started.catch(() => {});
  await assert.rejects(run.completion, { code: 'RESOURCE_LAUNCH_CALLER_REQUIRED' });
  assert.equal(roots, 0);
});

// Three independent clocks: the authority's wall clock, this client's wall
// clock, and this client's monotonic clock. These controlled counterexamples
// do not assert which predicate caused an intermittent real-machine failure.
for (const wallOffset of [-1, api.GRANT_MS + 1]) {
  test(`an on-time direct root does not depend on the client's wall clock offset (${wallOffset}ms)`, async t => {
    const f = fixture('both'); f.advise();
    const run = lane(t, f, { clientTiming: { now: () => f.now() + wallOffset, monotonic: () => 100 } });
    await run.execution.completion;
    assert.equal(run.roots(), 1);
    assert.equal(run.operations.filter(op => op === 'reserve').length, 1);
    assert.equal(run.operations.filter(op => op === 'revalidate').length, 1, 'clock independence is not permission to bypass the app');
    assert.equal(f.host.status().reservedBytes, 768 * 1024 ** 2);
    assert.equal(f.host.status().controller.claude.remaining, 0);
    run.child.emit('close', 0); await turn();
    assert.equal(f.host.status().reservedBytes, 0);
    assert.equal(run.channel.snapshot().active, 0);
  });
}

test('reply transit consumes the original short grant even if the client wall clock does not advance', async t => {
  const f = fixture('controller'); f.advise('allow', 100);
  let monotonic = 0;
  const run = lane(t, f, { clientTiming: { monotonic: () => monotonic },
    deliverReply(value, deliver) {
      if (value.ok === true && value.grantId) monotonic = 150;
      deliver();
    },
  });
  await assert.rejects(run.execution.completion, { code: 'AGENT_RESOURCE_GRANT_EXPIRED' });
  await turn();
  assert.equal(run.roots(), 0);
  assert.equal(run.operations.filter(op => op === 'cancel').length, 1);
  assert.equal(run.channel.snapshot().active, 0);
  assert.equal(f.host.status().reservedBytes, 0);
  assert.equal(f.host.status().controller.claude.remaining, 0, 'cancellation does not mint another controller allowance');
});

function pausedRequestTimers() {
  const pending = new Set();
  let fired = 0;
  return {
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, unref() {} };
      pending.add(timer);
      return timer;
    },
    unschedule(timer) { pending.delete(timer); },
    pending: () => pending.size,
    fired: () => fired,
    fireAll() {
      for (const timer of [...pending]) { pending.delete(timer); fired++; timer.callback(); }
    },
  };
}

for (const fireTimerFirst of [false, true]) {
  test(`a reserve reply past its request deadline is refused and cancelled once (${fireTimerFirst ? 'timer first' : 'timer starved'})`, async t => {
    const f = fixture();
    const timers = pausedRequestTimers();
    let monotonic = 0, deliverGrant;
    const run = lane(t, f, { clientTiming: { monotonic: () => monotonic, requestMs: 60,
      schedule: timers.schedule, unschedule: timers.unschedule },
      deliverReply(value, deliver) {
        if (value.ok === true && value.grantId) deliverGrant = deliver;
        else deliver();
      },
    });
    const refusal = assert.rejects(run.execution.completion, { code: 'AGENT_RESOURCE_UNKNOWN' });
    await turn();
    assert.equal(typeof deliverGrant, 'function');
    assert.equal(timers.pending(), 1);
    monotonic = 61;
    if (fireTimerFirst) timers.fireAll();
    deliverGrant();
    await refusal; await turn();
    assert.equal(timers.fired(), fireTimerFirst ? 1 : 0, 'a late reply must reject even when its timer callback has not run');
    assert.equal(run.roots(), 0);
    assert.equal(run.operations.filter(op => op === 'reserve').length, 1);
    assert.equal(run.operations.filter(op => op === 'revalidate').length, 0);
    assert.equal(run.operations.filter(op => op === 'cancel').length, 1);
    assert.equal(run.channel.snapshot().active, 0);
    assert.equal(f.host.status().reservedBytes, 0);
    assert.equal(timers.pending(), 0);
  });
}

test('a final revalidation reply past ROOT_CHECK_MS cannot pass while its request timer is starved', async t => {
  const f = fixture();
  const timers = pausedRequestTimers();
  let monotonic = 0, deliverRevalidation;
  const run = lane(t, f, { clientTiming: { monotonic: () => monotonic,
    schedule: timers.schedule, unschedule: timers.unschedule },
    deliverReply(value, deliver) {
      if (value.ok === true && value.expiresAtMs && !value.grantId) deliverRevalidation = deliver;
      else deliver();
    },
  });
  const refusal = assert.rejects(run.execution.completion, { code: 'AGENT_RESOURCE_UNKNOWN' });
  await turn();
  assert.equal(typeof deliverRevalidation, 'function');
  monotonic = api.ROOT_CHECK_MS + 1;
  deliverRevalidation();
  await refusal; await turn();
  assert.equal(timers.fired(), 0);
  assert.equal(run.roots(), 0);
  assert.equal(run.operations.filter(op => op === 'revalidate').length, 1);
  assert.equal(run.operations.filter(op => op === 'cancel').length, 1);
  assert.equal(run.channel.snapshot().active, 0);
  assert.equal(f.host.status().reservedBytes, 0);
  assert.equal(timers.pending(), 0);
});

for (const finalAt of [99, 100]) {
  test(`successful revalidation does not restart the grant budget (final boundary ${finalAt}ms into 100ms)`, async t => {
    const f = fixture('controller'); f.advise('allow', 100);
    let monotonic = 0;
    const run = lane(t, f, { clientTiming: { monotonic: () => monotonic },
      deliverReply(value, deliver) {
        if (value.ok === true && value.grantId) monotonic = 20;
        else if (value.ok === true && value.expiresAtMs) monotonic = 80;
        deliver();
      },
      afterPreparation() { monotonic = finalAt; },
    });
    if (finalAt < 100) {
      await run.execution.completion;
      assert.equal(run.roots(), 1, 'the original on-time budget remains usable');
      run.child.emit('close', 0);
    } else {
      await assert.rejects(run.execution.completion, { code: 'AGENT_RESOURCE_GRANT_EXPIRED' });
      assert.equal(run.roots(), 0, 'neither reply receipt may rearm the original deadline');
    }
    await turn();
    assert.equal(run.operations.filter(op => op === 'reserve').length, 1);
    assert.equal(run.operations.filter(op => op === 'revalidate').length, 1);
    assert.equal(f.host.status().reservedBytes, 0);
    assert.equal(f.host.status().controller.claude.remaining, 0);
    assert.equal(run.channel.snapshot().active, 0);
  });
}

test('a shorter app revalidation expiry shrinks the original request-start deadline, not a new receipt-relative budget', async t => {
  const f = fixture();
  let monotonic = 0;
  const expiries = [];
  // Advance the measured sample's age while the transport wall clock stays
  // fixed. The actual governor returns a shorter validForMs without changing
  // policy (a policy change correctly refuses, so it is not this control).
  const run = lane(t, f, { authorityNow: () => 12000,
    clientTiming: { now: () => 12000, monotonic: () => monotonic },
    deliverReply(value, deliver) {
      if (value.ok === true && value.grantId) {
        expiries.push(value.expiresAtMs);
        f.elapse(3500); monotonic = 500;
      } else if (value.ok === true && value.expiresAtMs) {
        // Keep this reply inside its separate 500ms request budget so the
        // final boundary tests the shortened grant, not a request timeout.
        expiries.push(value.expiresAtMs); monotonic = 999;
      }
      deliver();
    },
    afterPreparation() { monotonic = 2500; },
  });
  await assert.rejects(run.execution.completion, { code: 'AGENT_RESOURCE_GRANT_EXPIRED' });
  await turn();
  assert.deepEqual(expiries, [17000, 14500], 'the actual authority shortened its original sampled expiry');
  assert.equal(run.roots(), 0);
  assert.equal(run.operations.filter(op => op === 'revalidate').length, 1);
  assert.equal(run.operations.filter(op => op === 'cancel').length, 1);
  assert.equal(f.host.status().reservedBytes, 0);
  assert.equal(run.channel.snapshot().active, 0);
});

for (const finalClock of [-1, Number.NaN]) {
  test(`an invalid local elapsed-time observation cannot authorize a root (${String(finalClock)})`, async t => {
    const f = fixture();
    let monotonic = 0;
    const run = lane(t, f, { clientTiming: { monotonic: () => monotonic },
      afterPreparation() { monotonic = finalClock; },
    });
    await assert.rejects(run.execution.completion, { code: 'AGENT_RESOURCE_GRANT_EXPIRED' });
    assert.equal(run.roots(), 0);
    assert.equal(run.operations.filter(op => op === 'revalidate').length, 1);
  });
}
