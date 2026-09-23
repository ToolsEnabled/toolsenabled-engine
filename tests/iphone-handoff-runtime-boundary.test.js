'use strict';

require('./lib/isolated-environment').activate('iphone-handoff-runtime-boundary');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const registry = require('../src/lib/tool-registry');
const { executeTool } = require('./helpers/dispatch');
const handoff = require('../src/lib/providers/iphone-handoff');

// The active controller was extracted with its personal server in fe640324.
// Exercise the remaining customer door, not a fabricated replacement broker.
test('the public iPhone surface is one closed local-read readiness tool', () => {
  assert.deepEqual(registry.TOOL_REGISTRY.filter(tool => tool.name.startsWith('iphone.')).map(tool => tool.name),
    ['iphone.handoff_status']);
  const tool = registry.getTool('iphone.handoff_status');
  assert.equal(tool.effect, 'local-read');
  assert.deepEqual(tool.inputSchema, {
    type: 'object', properties: {}, required: [], additionalProperties: false
  });
});

test('real readiness dispatch never reads broker records or task-owner state', async () => {
  const original = handoff.handoffStatus;
  const expected = { device: 'present', pairing: 'not_observable', handoff: 'phone_side_bridge_not_configured' };
  const audit = [];
  let providerCalls = 0;
  let probeCalls = 0;
  let storageCalls = 0;
  handoff.handoffStatus = async input => {
    providerCalls += 1;
    const restore = [];
    const refuseStorage = () => { storageCalls += 1; throw new Error('readiness must not access broker or task storage'); };
    // Only the hardware probe and audit sink are controlled. Any filesystem
    // read inside the actual provider is a failure, even if it catches it.
    for (const [owner, methods] of [
      [fs, ['readFileSync', 'readFile', 'openSync', 'open', 'readdirSync', 'readdir']],
      [fs.promises, ['readFile', 'open', 'readdir']]
    ]) {
      for (const method of methods) {
        const previous = owner[method];
        owner[method] = refuseStorage;
        restore.push(() => { owner[method] = previous; });
      }
    }
    try {
      return await original(input, {
        platform: 'win32',
        audit: { record(action, target, details) { audit.push({ action, target, details }); } },
        runProbe: async (command, timeout) => {
          probeCalls += 1;
          assert.equal(command, handoff.POWERSHELL_PROBE);
          assert.equal(timeout, handoff.PROBE_TIMEOUT_MS);
          return { ok: true, stdout: JSON.stringify([{ Status: 'OK', Class: 'WPD',
            deviceId: 'fixture-device', recordId: 'fixture-record', taskId: 'fixture-task', grantId: 'fixture-grant' }]) };
        }
      });
    } finally {
      for (const reset of restore.reverse()) reset();
    }
  };
  try {
    assert.deepEqual(await executeTool('iphone.handoff_status', {}), expected);
    assert.equal(providerCalls, 1, 'the registry must dispatch to the real readiness provider');
    assert.equal(probeCalls, 1);
    assert.equal(storageCalls, 0, 'readiness must not acquire broker or task storage access');
    assert.deepEqual(audit, [{ action: 'iphone.handoff_status', target: 'local-mobile-device', details: expected }]);
    for (const field of ['recordId', 'recordDirectory', 'taskId', 'ownerGrant', 'enabled']) {
      await assert.rejects(executeTool('iphone.handoff_status', { [field]: 'fixture' }),
        error => error && error.code === 'INVALID_PARAMS');
    }
    assert.equal(providerCalls, 1, 'broker-shaped requests must fail before entering the provider');
  } finally {
    handoff.handoffStatus = original;
  }
});

test('readiness cannot project an active grant or authoritative task result', () => {
  const readiness = handoff.summarize([{ Status: 'OK', Class: 'WPD' }]);
  for (const field of ['activeHandoff', 'taskId', 'grantId', 'grantsAuthority']) {
    assert.throws(() => handoff.controllerReadiness({ ...readiness, [field]: 'fixture' }, 1_000),
      error => error && error.code === 'IPHONE_HANDOFF_STATUS_INVALID');
  }
  assert.deepEqual(handoff.controllerReadiness(readiness, 1_000), {
    schemaVersion: 1, observedAt: '1970-01-01T00:00:01.000Z', readiness
  });
});
