'use strict';

require('../lib/isolated-environment').activate('iphone-handoff');
const assert = require('node:assert/strict');
const handoff = require('../../src/lib/providers/iphone-handoff');

(async () => {
  assert.deepEqual(handoff.summarize([]), { device: 'absent', pairing: 'not_observable', handoff: 'unavailable' });
  assert.deepEqual(handoff.summarize([{ Status: 'OK', Class: 'WPD' }]), { device: 'present', pairing: 'not_observable', handoff: 'phone_side_bridge_not_configured' });
  assert.deepEqual(handoff.summarize([], false), { device: 'probe_unavailable', pairing: 'not_observable', handoff: 'unavailable' });
  assert.deepEqual(handoff.controllerReadiness(handoff.summarize([{ Status: 'OK', Class: 'WPD' }]), 1_000), {
    schemaVersion: 1,
    observedAt: '1970-01-01T00:00:01.000Z',
    readiness: { device: 'present', pairing: 'not_observable', handoff: 'phone_side_bridge_not_configured' }
  });
  assert.throws(
    () => handoff.controllerReadiness({ ...handoff.summarize([]), deviceId: 'do-not-project' }, 1_000),
    error => error && error.code === 'IPHONE_HANDOFF_STATUS_INVALID'
  );
  const hiddenReadiness = { ...handoff.summarize([]) };
  Object.defineProperty(hiddenReadiness, 'privateValue', { value: true });
  assert.throws(
    () => handoff.controllerReadiness(hiddenReadiness, 1_000),
    error => error && error.code === 'IPHONE_HANDOFF_STATUS_INVALID'
  );
  assert.throws(
    () => handoff.controllerReadiness({ ...handoff.summarize([]), [Symbol('private-value')]: true }, 1_000),
    error => error && error.code === 'IPHONE_HANDOFF_STATUS_INVALID'
  );
  let getterReads = 0;
  const accessorReadiness = { ...handoff.summarize([]) };
  Object.defineProperty(accessorReadiness, 'device', {
    enumerable: true,
    get() { getterReads += 1; throw new Error('getter must not run'); }
  });
  assert.throws(
    () => handoff.controllerReadiness(accessorReadiness, 1_000),
    error => error && error.code === 'IPHONE_HANDOFF_STATUS_INVALID'
  );
  assert.equal(getterReads, 0);
  let proxyReads = 0;
  const proxyReadiness = new Proxy({ ...handoff.summarize([]) }, {
    get() { proxyReads += 1; throw new Error('proxy get trap must not run'); }
  });
  assert.deepEqual(handoff.controllerReadiness(proxyReadiness, 1_000).readiness, handoff.summarize([]));
  assert.equal(proxyReads, 0);
  assert.deepEqual(handoff.parseRows('{"Status":"OK","Class":"WPD"}'), [{ Status: 'OK', Class: 'WPD' }]);
  assert.throws(() => handoff.parseRows(''), error => error && error.code === 'IPHONE_HANDOFF_PROBE_INVALID');
  assert.throws(() => handoff.parseRows('{"Status":"OK","Class":1}'), error => error && error.code === 'IPHONE_HANDOFF_PROBE_INVALID');
  const audits = [];
  const result = await handoff.handoffStatus({}, {
    platform: 'win32', audit: { record(action, target, details) { audits.push({ action, target, details }); } },
    runProbe: async (command, timeout) => { assert.equal(command, handoff.POWERSHELL_PROBE); assert.equal(timeout, handoff.PROBE_TIMEOUT_MS); return { ok: true, stdout: '[{"Status":"OK","Class":"WPD"}]' }; }
  });
  assert.deepEqual(result, { device: 'present', pairing: 'not_observable', handoff: 'phone_side_bridge_not_configured' });
  assert.deepEqual(audits, [{ action: 'iphone.handoff_status', target: 'local-mobile-device', details: result }]);
  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    let auditCalls = 0;
    await assert.rejects(handoff.handoffStatus({}, {
      platform: 'win32', audit: { record() { auditCalls += 1; } },
      runProbe: async () => { throw Object.assign(new Error('probe did not answer'), { code }); }
    }), error => error && error.code === 'IPHONE_HANDOFF_PROBE_UNAVAILABLE'
      && /does NOT claim that an iPhone is absent/.test(error.message));
    assert.equal(auditCalls, 0, `${code} must not audit a fabricated absence`);
  }
  await assert.rejects(handoff.handoffStatus({}, {
    platform: 'win32', audit: { record() { throw new Error('must not audit'); } },
    runProbe: async () => ({ ok: true, stdout: '' })
  }), error => error && error.code === 'IPHONE_HANDOFF_PROBE_UNAVAILABLE');
  let uncachedProbeCalls = 0;
  const successfulAbsent = {
    platform: 'win32', audit: { record() {} },
    runProbe: async () => { uncachedProbeCalls += 1; return { ok: true, stdout: '[]' }; }
  };
  assert.deepEqual(await handoff.handoffStatus({}, successfulAbsent), handoff.summarize([]),
    'CONTROL: a successful empty inventory remains the legitimate absent answer');
  assert.deepEqual(await handoff.handoffStatus({}, successfulAbsent), handoff.summarize([]));
  assert.equal(uncachedProbeCalls, 2, 'probe failures and results are never cached or latched');
  let boundaryCalls = 0;
  const boundaryDependencies = {
    platform: 'win32',
    audit: { record() { boundaryCalls += 1; } },
    runProbe: async () => { boundaryCalls += 1; return { ok: true, stdout: '[]' }; }
  };
  const hiddenRequest = {};
  Object.defineProperty(hiddenRequest, 'privateValue', { value: true });
  await assert.rejects(
    () => handoff.handoffStatus(hiddenRequest, boundaryDependencies),
    error => error && error.code === 'IPHONE_HANDOFF_STATUS_INVALID'
  );
  await assert.rejects(
    () => handoff.handoffStatus({ [Symbol('private-value')]: true }, boundaryDependencies),
    error => error && error.code === 'IPHONE_HANDOFF_STATUS_INVALID'
  );
  assert.equal(boundaryCalls, 0, 'closed status input must fail before probing or auditing');
  const unsupported = await handoff.handoffStatus({}, { platform: 'linux', audit: { record() {} }, runProbe: async () => { throw new Error('must not run'); } });
  assert.deepEqual(unsupported, { device: 'unsupported_platform', pairing: 'not_observable', handoff: 'unavailable' });
  process.stdout.write('iPhone handoff status tests passed.\n');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
