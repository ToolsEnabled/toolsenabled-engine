'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const policy = require('../permission-tier-policy');
const { MissionBridgeError } = require('./errors');

// Only the installation-owner HTTP surface follows setup live. Agent and
// remote sessions retain the explicit ceiling bound by their own transports.
function createOwnerPermissionScope({ enabled, machineRecord }) {
  const calls = new AsyncLocalStorage();
  function snapshot() {
    let record = null;
    let permissionSession = policy.installTierSession('guided');
    try {
      record = machineRecord.readMachineRecord({ servicesRoot: machineRecord.resolveServicesRoot({}) });
      permissionSession = policy.installTierSessionFromRecord(record);
    } catch { record = null; }
    return Object.freeze({ permissionSession,
      fingerprint: createHash('sha256').update(JSON.stringify(record)).digest('hex') });
  }
  function assertCurrent() {
    if (!enabled) return;
    const held = calls.getStore();
    if (!held || held.fingerprint !== snapshot().fingerprint) {
      throw new MissionBridgeError('BRIDGE_PERMISSION_CHANGED',
        'The recorded permission level changed or became unreadable during this request. Retry with the current settings.', { status: 409 });
    }
  }
  return Object.freeze({
    run: action => enabled ? calls.run(snapshot(), action) : action(),
    session: fallback => {
      if (!enabled) return fallback;
      assertCurrent();
      return calls.getStore().permissionSession;
    },
    assertCurrent,
    enabled,
  });
}

module.exports = { createOwnerPermissionScope };
