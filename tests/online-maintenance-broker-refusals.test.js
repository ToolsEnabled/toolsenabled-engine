'use strict';

const assert = require('node:assert/strict');
const maintenance = require('../src/lib/online-maintenance-contract');
const { createOnlineMaintenanceBroker } = require('../src/lib/online-maintenance-broker');

function fixture(overrides = {}) {
  const calls = { audit: 0, kill: 0, launch: 0, open: 0, session: 0 };
  const generation = overrides.generation ?? 7;
  const options = {
    audit: {
      record: async () => { calls.audit += 1; },
      require: async () => { calls.audit += 1; }
    },
    enabled: true,
    expectedServiceIdentity: {
      name: maintenance.SERVICE_ACCOUNT,
      nonAdmin: true,
      serviceAccount: maintenance.SERVICE_ACCOUNT,
      sid: 'service-sid',
      uid: 'service-uid'
    },
    generation,
    killProcessTree: async () => { calls.kill += 1; },
    killSwitchActive: false,
    launch: async () => { calls.launch += 1; },
    maxConcurrency: 1,
    maxQueue: 0,
    openBeneath: async () => { calls.open += 1; },
    profile: maintenance.createOnlineMaintenanceProfile({ identityGeneration: generation }),
    serviceIdentity: async () => ({
      name: maintenance.SERVICE_ACCOUNT,
      nonAdmin: true,
      serviceAccount: maintenance.SERVICE_ACCOUNT,
      sid: 'service-sid',
      uid: 'service-uid'
    }),
    sessionState: { consume: async () => { calls.session += 1; } }
  };
  Object.assign(options, overrides);
  return { calls, options };
}

function assertNoEffects(calls) {
  assert.deepEqual(calls, { audit: 0, kill: 0, launch: 0, open: 0, session: 0 });
}

{
  const { calls, options } = fixture();
  options.profile = maintenance.createOnlineMaintenanceProfile({ identityGeneration: 8 });
  assert.throws(
    () => createOnlineMaintenanceBroker(options),
    error => error.code === 'ONLINE_MAINTENANCE_BROKER_GENERATION_INVALID'
  );
  assertNoEffects(calls);
}

{
  const { calls, options } = fixture({ sessionState: { consume: 'not-an-adapter' } });
  assert.throws(
    () => createOnlineMaintenanceBroker(options),
    error => error.code === 'ONLINE_MAINTENANCE_SESSION_STATE_REQUIRED'
  );
  assertNoEffects(calls);
}

(async () => {
  const { calls, options } = fixture();
  const broker = createOnlineMaintenanceBroker(options);
  const before = broker.snapshot();
  await assert.rejects(
    broker.setControl({ enabled: false, generation: 7, killSwitchActive: 'no' }),
    error => error.code === 'ONLINE_MAINTENANCE_CONTROL_INVALID'
  );
  assert.deepEqual(broker.snapshot(), before, 'invalid control must not change broker state');
  assertNoEffects(calls);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
