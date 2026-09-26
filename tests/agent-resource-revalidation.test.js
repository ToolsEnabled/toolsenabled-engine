'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResourceAdmission } = require('../src/lib/agent-resource-admission');
const GB = 1024 ** 3;
function fixture(mode = 'mechanical', freeBytes = 3 * GB) {
  let at = 10000; let authority = true; let settings = { mode };
  const governor = createResourceAdmission({ now: () => at, settings: () => settings, authorizeAdvice: () => authority });
  const sample = (cpuPercent = 20) => governor.recordSample({ atMs: at, cpuPercent, freeBytes, totalBytes: 32 * GB, loopLagMs: 0 });
  const advance = (cpu = 20, ms = 1000) => { at += ms; sample(cpu); };
  sample(); advance(); advance();
  return { governor, advance, elapse(ms) { at += ms; }, settings(value) { settings = value; }, revoke() { authority = false; },
    advice(id = 'first', decision = 'allow') { assert.equal(governor.setAdvice({ id, provider: 'claude', controllerId: 'root',
      decision, launches: decision === 'allow' ? 1 : 0, expiresAtMs: at + 10000, reason: 'Bounded fixture advice.' }), true); },
  };
}

test('the latest root check counts its existing RAM reservation once and cannot be consumed twice', () => {
  const f = fixture(); const lease = f.governor.reserve({ provider: 'claude' });
  assert.equal(lease.ok, true);
  assert.equal(f.governor.revalidate(lease.token).ok, true, '3 GiB covers 2 GiB reserve plus one 768 MiB launch, not two');
  assert.equal(f.governor.snapshot().reservedBytes, 768 * 1024 ** 2);
  assert.equal(f.governor.revalidate(lease.token).code, 'AGENT_RESOURCE_GRANT_USED');
});

test('one already-spent controller credit validates once without requiring a second credit or refilling it', () => {
  const f = fixture('both'); f.advice(); const lease = f.governor.reserve({ provider: 'claude' });
  assert.equal(lease.ok, true); assert.equal(f.governor.snapshot().controller.claude.remaining, 0);
  assert.equal(f.governor.revalidate(lease.token).ok, true);
  assert.equal(f.governor.snapshot().controller.claude.remaining, 0);
  f.governor.release(lease.token); f.advance();
  assert.equal(f.governor.reserve({ provider: 'claude' }).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
});

test('new pressure, new hold, and revoked controller authority invalidate an otherwise unexpired reservation', () => {
  const pressure = fixture(); const first = pressure.governor.reserve({ provider: 'claude' }); pressure.advance(99);
  assert.equal(pressure.governor.revalidate(first.token).code, 'AGENT_RESOURCE_PRESSURE');
  assert.equal(pressure.governor.snapshot().reservedBytes, 768 * 1024 ** 2);
  for (const change of [f => f.advice('second', 'hold'), f => f.revoke()]) {
    const f = fixture('controller'); f.advice(); const lease = f.governor.reserve({ provider: 'claude' }); change(f);
    assert.equal(f.governor.revalidate(lease.token).ok, false);
  }
});

test('a replaced allowance or changed enabled policy needs a fresh reservation, not reuse of an old debit', () => {
  const f = fixture('controller'); f.advice(); const lease = f.governor.reserve({ provider: 'claude' }); f.advice('second');
  assert.equal(f.governor.revalidate(lease.token).code, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN');
  assert.equal(f.governor.snapshot().controller.claude.remaining, 1);
  const mechanical = fixture(); const pending = mechanical.governor.reserve({ provider: 'claude' });
  mechanical.settings({ mode: 'mechanical', reserveBytes: GB });
  assert.equal(mechanical.governor.revalidate(pending.token).code, 'AGENT_RESOURCE_POLICY_CHANGED');
});

test('All off disables policy at the actual root check; enabling policy cannot reuse an uncharged Off grant', () => {
  const f = fixture(); const pending = f.governor.reserve({ provider: 'claude' }); f.advance(99); f.settings({ mode: 'off' });
  assert.equal(f.governor.revalidate(pending.token).ok, true);
  const uncharged = f.governor.reserve({ provider: 'claude' }); assert.equal(uncharged.token, null);
  assert.equal(f.governor.revalidate(uncharged.token).ok, true);
  f.settings({ mode: 'mechanical' });
  assert.equal(f.governor.revalidate(uncharged.token).code, 'AGENT_RESOURCE_POLICY_CHANGED');
});

test('wrapper timing cannot collapse separately admitted roots into an uncontrolled burst', () => {
  const f = fixture('mechanical', 8 * GB);
  const first = f.governor.reserve({ provider: 'claude' }); f.advance();
  const second = f.governor.reserve({ provider: 'claude' });
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(f.governor.revalidate(first.token).ok, true);
  assert.equal(f.governor.revalidate(second.token).code, 'AGENT_RESOURCE_PACING');
  f.elapse(250); assert.equal(f.governor.revalidate(second.token).ok, true);
});

test('a newly busy but stable window spaces already-reserved provider roots by five seconds', () => {
  const f = fixture('mechanical', 8 * GB);
  const first = f.governor.reserve({ provider: 'claude' }); f.advance();
  const second = f.governor.reserve({ provider: 'claude' });
  f.advance(85); f.advance(85); f.advance(85);
  assert.equal(f.governor.revalidate(first.token).ok, true);
  f.governor.ready(first.token);
  for (let index = 0; index < 4; index++) {
    f.advance(85); assert.equal(f.governor.revalidate(second.token).code, 'AGENT_RESOURCE_PACING');
  }
  f.advance(85); assert.equal(f.governor.revalidate(second.token).ok, true);
});

test('the original owner-confirmed memory exception survives the final check but never bypasses fresh pressure', () => {
  const allowed = fixture('mechanical', 0);
  const first = allowed.governor.reserve({ provider: 'claude', acknowledged: true });
  assert.equal(first.ok, true);
  assert.equal(allowed.governor.revalidate(first.token).ok, true);
  const refused = fixture('mechanical', 0);
  const second = refused.governor.reserve({ provider: 'claude', acknowledged: true }); refused.advance(99);
  assert.equal(refused.governor.revalidate(second.token).code, 'AGENT_RESOURCE_PRESSURE');
});

test('a real controller bootstrap retains its mechanical policy in both controller-requiring modes', () => {
  for (const mode of ['both', 'controller']) {
    const f = fixture(mode);
    const pending = f.governor.reserve({ provider: 'claude', bootstrapController: true });
    assert.equal(pending.ok, true);
    const ready = f.governor.revalidate(pending.token);
    assert.equal(ready.ok, true); assert.equal(ready.state.mode, 'mechanical'); assert.equal(ready.state.configuredMode, mode);
    assert.equal(ready.state.bootstrapController, true);
    const stale = fixture(mode);
    const grant = stale.governor.reserve({ provider: 'claude', bootstrapController: true }); stale.elapse(6001);
    assert.equal(stale.governor.revalidate(grant.token).code, 'AGENT_RESOURCE_UNKNOWN');
  }
});
