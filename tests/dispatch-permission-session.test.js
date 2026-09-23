/*
 * Mutation: changed `recorded.tier === 'full'` to `recorded.tier === 'confined'`.
 * Landed: yes; the changed condition was printed from the module before the run.
 * Result: this isolated test went red (exit 1), rejecting the widened guided session.
 */
'use strict';

const assert = require('node:assert/strict');
const {
  UNATTENDED_CEILING,
  recordedInstallSession,
  unattendedSession
} = require('../src/lib/dispatch-permission-session');

function recordReader(tier) {
  const calls = [];
  return {
    calls,
    resolveServicesRoot(options) {
      calls.push(['resolveServicesRoot', options]);
      return '/test/services';
    },
    readMachineRecord(options) {
      calls.push(['readMachineRecord', options]);
      return { tier };
    }
  };
}

function main() {
  assert.deepEqual(UNATTENDED_CEILING,
    { origin: 'local', tier: 'confined', profile: 'workspace' });
  assert.ok(Object.isFrozen(UNATTENDED_CEILING), 'the exported ceiling must be immutable');

  const expectedRecordedSessions = {
    guided: { origin: 'local', tier: 'confined', profile: 'read-only' },
    standard: { origin: 'local', tier: 'confined', profile: 'workspace' },
    unrestricted: { origin: 'local', tier: 'full' }
  };

  for (const [tier, expected] of Object.entries(expectedRecordedSessions)) {
    const machineRecord = recordReader(tier);
    assert.deepEqual(recordedInstallSession({ machineRecord }), expected,
      `${tier} must resolve to its recorded installation session`);
    assert.deepEqual(machineRecord.calls, [
      ['resolveServicesRoot', {}],
      ['readMachineRecord', { servicesRoot: '/test/services' }]
    ], 'the record must be read from the resolved services root');
  }

  const unreadable = recordReader('administrator');
  assert.throws(
    () => recordedInstallSession({ machineRecord: unreadable }),
    error => error?.code === 'PERMISSION_INSTALL_TIER_REFUSED',
    'an unknown recorded tier must fail closed'
  );

  for (const tier of ['guided', 'standard']) {
    assert.deepEqual(unattendedSession({ machineRecord: recordReader(tier) }),
      expectedRecordedSessions[tier],
      `${tier} must not be widened for unattended work`);
  }

  assert.deepEqual(unattendedSession({ machineRecord: recordReader('unrestricted') }),
    UNATTENDED_CEILING,
    'an unrestricted installation must be clamped to the confined workspace ceiling when unattended');

  console.log('dispatch-permission-session: behavior checks passed');
}

main();
