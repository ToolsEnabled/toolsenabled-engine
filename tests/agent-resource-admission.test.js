'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createResourceAdmission, normalizeSettings } = require('../src/lib/agent-resource-admission');
const { createResourceSampler } = require('../src/lib/agent-resource-monitor');
const GIB = 1024 ** 3;

function fixture(settings = {}) {
  let at = 100000;
  let authorized = true;
  const governor = createResourceAdmission({ now: () => at, settings: () => ({ mode: 'mechanical', ...settings }), authorizeAdvice: () => authorized });
  const tick = (cpuPercent = 20, freeBytes = 16 * GIB, extra = {}) => {
    at += 1000;
    governor.recordSample({ atMs: at, cpuPercent, freeBytes, totalBytes: 32 * GIB, logicalProcessors: 4, loopLagMs: 0, ...extra });
  };
  const warm = (cpu = 20, free = 16 * GIB) => { tick(cpu, free); tick(cpu, free); tick(cpu, free); };
  const advice = (extra = {}) => governor.setAdvice({ id: 'advice-1', provider: 'claude', controllerId: 'controller-node', controllerSessionId: 'controller-session', decision: 'allow', launches: 2, expiresAtMs: at + 30000, ...extra });
  return { governor, tick, warm, advice, advance: ms => { at += ms; }, now: () => at, revoke: () => { authorized = false; } };
}

test('native CPU sampler requires an elapsed interval and reports physical RAM, not invented commit headroom', () => {
  let at = 1000;
  let user = 100;
  const sampler = createResourceSampler({ now: () => at, cpus: () => [{ times: { idle: 1000, user } }], freeMemory: () => 2 * GIB, totalMemory: () => 8 * GIB });
  assert.equal(sampler().cpuPercent, null);
  at += 1000; user += 1000;
  const measured = sampler();
  assert.equal(measured.cpuPercent, 100);
  assert.equal(measured.atMs, 2000);
  assert.equal(measured.freeBytes, 2 * GIB);
  assert.equal(measured.logicalProcessors, 1);
  at += 11000; user += 1000;
  assert.equal(sampler().cpuPercent, null, 'a stale counter interval must not be relabelled current CPU');
});

test('unreadable native counters become unknown without throwing or starting helper processes', () => {
  const sampler = createResourceSampler({ cpus: () => { throw new Error('unreadable'); } });
  assert.equal(sampler().cpuPercent, null);
  assert.equal(sampler().freeBytes, null);
});

test('missing, stale and unstable near-capacity measurements hold mechanical launch admission', () => {
  const f = fixture();
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_UNKNOWN');
  f.tick(20);
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_WARMING');
  f.tick(85); f.tick(20);
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_WARMING');
  f.advance(6001);
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_UNKNOWN');
});

test('a fresh low-load window admits ordinary CPU fluctuations without claiming stability', () => {
  const f = fixture();
  f.tick(17); f.tick(58); f.tick(24);
  const result = f.governor.reserve({ provider: 'claude' });
  assert.equal(result.ok, true);
  assert.equal(result.state.readyWindow, true);
  assert.equal(result.state.stable, false, 'admission must not relabel fluctuating CPU as steady');
  assert.equal(result.state.headroomWindow, true);
  assert.equal(result.state.cpuWindowMaxPercent, 58);
  assert.equal(f.governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_PACING');
  f.advance(250);
  assert.equal(f.governor.reserve({ provider: 'claude' }).ok, true);
});

test('one cool reading cannot hide a recent near-capacity sample', () => {
  const f = fixture();
  f.tick(85); f.tick(30); f.tick(20);
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_WARMING');
  f.tick(45);
  assert.equal(f.governor.inspect({ provider: 'claude' }).ok, true, 'the complete new window is below capacity');
});

test('a stable window straddling 80 percent retains cautious one-start pacing', () => {
  const f = fixture();
  f.tick(80); f.tick(78); f.tick(75);
  const first = f.governor.reserve({ provider: 'claude' });
  assert.equal(first.ok, true);
  assert.equal(first.state.stable, true);
  assert.equal(first.state.headroomWindow, false);
  f.governor.ready(first.token);
  f.advance(250);
  assert.equal(f.governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_PACING');
  for (let i = 0; i < 5; i += 1) f.tick(75);
  assert.equal(f.governor.reserve({ provider: 'claude' }).ok, true);
});

test('low CPU headroom never bypasses unknown readings or memory reservations', () => {
  const f = fixture();
  f.tick(17, 2.5 * GIB); f.tick(58, 2.5 * GIB); f.tick(24, 2.5 * GIB);
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_MEMORY_LOW');
  f.tick(null);
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_UNKNOWN');
  assert.equal(f.governor.snapshot().readyWindow, false);
  assert.equal(f.governor.snapshot().headroomWindow, false);
});

test('three rapid samples do not replace a measured elapsed window', () => {
  const f = fixture();
  for (let i = 0; i < 3; i += 1) {
    f.advance(100);
    f.governor.recordSample({ atMs: f.now(), cpuPercent: 20, freeBytes: 16 * GIB, totalBytes: 32 * GIB });
  }
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_WARMING');
  assert.equal(f.governor.snapshot().readyWindow, false);
});

test('99 percent CPU blocks immediately and requires three cool measurements to recover', () => {
  const f = fixture(); f.warm(30); f.tick(99);
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_PRESSURE');
  f.tick(89); f.tick(89);
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_PRESSURE');
  f.tick(89);
  assert.equal(f.governor.inspect({ provider: 'claude' }).ok, true);
});

test('85 percent stable may probe one more start regardless of the number already running', () => {
  const f = fixture(); f.warm(85);
  const first = f.governor.reserve({ provider: 'claude' });
  assert.equal(first.ok, true);
  assert.equal(f.governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_PACING');
  f.governor.ready(first.token);
  f.tick(85); f.tick(85); f.tick(85); f.tick(85); f.tick(85);
  assert.equal(f.governor.reserve({ provider: 'claude' }).ok, true);
});

test('application-loop delay holds new starts even when CPU is otherwise low', () => {
  const f = fixture(); f.warm(); f.tick(20, 16 * GIB, { loopLagMs: 700 });
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_PRESSURE');
});

test('outstanding reservations prevent concurrent starts from all spending the same free RAM', () => {
  const f = fixture(); f.warm(20, 4 * GIB);
  const one = f.governor.reserve({ provider: 'claude' });
  assert.equal(one.ok, true);
  f.advance(250);
  const two = f.governor.reserve({ provider: 'claude' });
  assert.equal(two.ok, true);
  f.advance(250);
  assert.equal(f.governor.reserve({ provider: 'claude' }).code, 'AGENT_MEMORY_LOW');
  assert.equal(f.governor.snapshot().reservedBytes, 1.5 * GIB);
  f.governor.release(one.token);
  assert.equal(f.governor.reserve({ provider: 'claude' }).ok, true);
});

test('successful launch reservations survive wall time until a fresh post-settling RAM sample', () => {
  const f = fixture(); f.warm();
  const admission = f.governor.reserve({ provider: 'claude' });
  f.governor.ready(admission.token);
  f.advance(10000);
  assert.ok(f.governor.snapshot().reservedBytes > 0);
  f.tick(20);
  assert.equal(f.governor.snapshot().reservedBytes, 0);
});

test('provider memory profiles are distinct, configurable estimates, not agent-count limits', () => {
  const f = fixture(); f.warm(20, 2.8 * GIB);
  assert.equal(f.governor.inspect({ provider: 'claude' }).ok, true);
  assert.equal(f.governor.inspect({ provider: 'codex' }).code, 'AGENT_MEMORY_LOW');
  const adjusted = fixture({ providerBytes: { codex: 0.5 * GIB } }); adjusted.warm(20, 2.8 * GIB);
  assert.equal(adjusted.governor.inspect({ provider: 'codex' }).ok, true);
  assert.equal(normalizeSettings({ mode: 'invented' }).mode, 'off');
});

test('All off really disables memory, CPU and controller admission', () => {
  const f = fixture({ mode: 'off' });
  f.tick(99, 0);
  const result = f.governor.reserve({ provider: 'claude' });
  assert.equal(result.ok, true);
  assert.equal(result.token, null);
});

test('controller-only needs real current advice but does not secretly apply mechanical memory policy', () => {
  const f = fixture({ mode: 'controller' }); f.tick(99, 0);
  assert.equal(f.governor.inspect({ provider: 'claude' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
  assert.equal(f.advice(), true);
  assert.equal(f.governor.reserve({ provider: 'claude' }).ok, true);
  assert.equal(f.governor.reserve({ provider: 'claude' }).ok, true);
  assert.equal(f.governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
});

test('controller credit cannot bypass mechanical pressure when both are enabled', () => {
  const f = fixture({ mode: 'both' }); f.warm(99); f.advice();
  assert.equal(f.governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_PRESSURE');
});

test('advice is single-use budgeted, cannot be replayed, and loses authority when the controller is revoked', () => {
  const f = fixture({ mode: 'controller' }); f.advice({ launches: 1 });
  f.governor.reserve({ provider: 'claude' });
  f.advice({ launches: 1 });
  assert.equal(f.governor.reserve({ provider: 'claude' }).ok, false, 'reading the same advice refilled credit');
  f.advice({ id: 'advice-2' });
  assert.equal(f.advice({ id: 'advice-1' }), false, 'an earlier instruction was replayed after a later one');
  f.revoke();
  assert.equal(f.governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
});

test('expired advice and overlong expiries never permit a start', () => {
  const f = fixture({ mode: 'controller' });
  assert.equal(f.advice({ expiresAtMs: f.now() + 60001 }), false);
  f.advice(); f.advance(30001);
  assert.equal(f.governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
});

test('an explicitly authenticated controller bootstrap uses mechanical checks instead of waiting on its own advice', () => {
  const f = fixture({ mode: 'both' }); f.warm();
  assert.equal(f.governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
  const admitted = f.governor.reserve({ provider: 'claude', bootstrapController: true });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.state.bootstrapController, true);
  f.tick(99);
  assert.equal(f.governor.reserve({ provider: 'claude', bootstrapController: true }).code, 'AGENT_RESOURCE_PRESSURE');
});

test('a resource refusal says which scarcity it measured, so a retry can classify before it loops', () => {
  /* Measured in the owner's signed spawn record 2026-09-14T09Z: 558
     AGENT_RESOURCE_PRESSURE refusals in one hour for one node, every one
     worded as a CPU ceiling although the latch also trips on loop lag and on
     an unreadable sample. Assert the classification by driving each hold. */
  const cpu = fixture(); cpu.warm(30); cpu.tick(99);
  const cpuHold = cpu.governor.inspect({ provider: 'claude' });
  assert.equal(cpuHold.code, 'AGENT_RESOURCE_PRESSURE');
  assert.equal(cpuHold.measured.cause, 'cpu-ceiling');
  assert.equal(cpuHold.measured.cpuPercent, 99);
  assert.equal(cpuHold.measured.cpuCeilingPercent, 97);

  const lag = fixture(); lag.warm(); lag.tick(20, 16 * GIB, { loopLagMs: 700 });
  const lagHold = lag.governor.inspect({ provider: 'claude' });
  assert.equal(lagHold.code, 'AGENT_RESOURCE_PRESSURE');
  assert.equal(lagHold.measured.cause, 'loop-lag');
  assert.equal(lagHold.measured.loopLagMs, 700);
  assert.equal(lagHold.measured.cpuPercent, 20);
  assert.notEqual(lagHold.reason, cpuHold.reason, 'two different scarcities must not refuse with the same sentence');
  assert.equal(lag.governor.snapshot().pressureCause, 'loop-lag');

  /* An unreadable sample latches pressure; the next readable sample is still
     under that latch, and the refusal names the unreadable sample as its cause. */
  const unread = fixture(); unread.warm(); unread.tick(-5); unread.tick(20);
  const unreadHold = unread.governor.inspect({ provider: 'claude' });
  assert.equal(unreadHold.code, 'AGENT_RESOURCE_PRESSURE');
  assert.equal(unreadHold.measured.cause, 'unreadable-sample');

  const memory = fixture(); memory.warm(20, 1 * GIB);
  const memoryHold = memory.governor.inspect({ provider: 'claude' });
  assert.equal(memoryHold.code, 'AGENT_MEMORY_LOW');
  assert.equal(memoryHold.measured.cause, 'memory');
  assert.equal(memoryHold.measured.freeBytes, 1 * GIB);
  assert.ok(memoryHold.measured.neededBytes > 1 * GIB);

  /* Recovery clears the cause with the latch. */
  lag.tick(20); lag.tick(20); lag.tick(20);
  assert.equal(lag.governor.inspect({ provider: 'claude' }).ok, true);
  assert.equal(lag.governor.snapshot().pressureCause, null);
});


test('fresh Basic admission allows supported starts without resource observations', () => {
  const governor = createResourceAdmission();
  for (const provider of ['claude', 'codex', 'gemini', 'grok', 'local']) {
    const result = governor.reserve({ provider });
    assert.equal(result.ok, true); assert.equal(result.state.mode, 'off'); assert.equal(result.token, null);
  }
  assert.equal(normalizeSettings({ mode: 'invalid' }).mode, 'off');
  assert.equal(governor.reserve({ provider: 'invented' }).code, 'AGENT_RESOURCE_PROVIDER_UNKNOWN');
});


test('explicit governor recovery names the captured stall and progress, never a zero-ms cause', () => {
  const f = fixture(); f.warm(); f.tick(12, 16 * GIB, { loopLagMs: 1307 });
  const triggered = f.governor.inspect({ provider: 'claude' });
  f.tick(10, 16 * GIB, { loopLagMs: 0 });
  const recovering = f.governor.inspect({ provider: 'claude' });
  assert.equal(recovering.code, 'AGENT_RESOURCE_PRESSURE');
  assert.equal(recovering.measured.loopLagMs, 0, 'latest sample remains separately available');
  assert.equal(recovering.measured.trigger.loopLagMs, 1307);
  assert.equal(recovering.measured.trigger.atMs, triggered.state.atMs);
  assert.equal(recovering.measured.recoverySamples, 1);
  assert.match(recovering.reason, /1307 ms/);
  assert.match(recovering.reason, /1 of 3/);
  assert.doesNotMatch(recovering.reason, /stalled 0 ms|paging|swapping/i);
  f.tick(11, 16 * GIB, { loopLagMs: 0 });
  assert.match(f.governor.inspect({ provider: 'claude' }).reason, /2 of 3/);
  f.tick(12, 16 * GIB, { loopLagMs: 0 });
  assert.equal(f.governor.inspect({ provider: 'claude' }).ok, true);
  assert.equal(f.governor.snapshot().pressureTrigger, null);
});
