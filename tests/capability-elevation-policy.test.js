// Mutation check:
// Changed `minutes * 60 * 1000` to `minutes * 60 * 100` in the policy module.
// The mutation landed (the changed source line was found before the run).
// This isolated test went red with exit code 1 on the durationMs assertion.
// The module was then restored and its original SHA-256 was confirmed.

'use strict';

const assert = require('node:assert/strict');

const {
  CapabilityElevationPolicyError,
  ELEVATION_DURATION_ID,
  ELEVATION_SURVIVES_RESTART_ID,
  RESTART_REVOCATION_REASON,
  boundedCompileInput,
  prepareState,
  resolvePolicy
} = require('../src/lib/capability-elevation-policy');

function settings(minutes, survivesRestart) {
  return {
    loadSettings: () => ({
      values: {
        [ELEVATION_DURATION_ID]: minutes,
        [ELEVATION_SURVIVES_RESTART_ID]: survivesRestart
      },
      valuesPath: '/customer/settings.json',
      rejected: []
    })
  };
}

const policy = resolvePolicy(settings(7, true));
assert.deepEqual(policy, {
  durationMs: 420000,
  survivesRestart: true,
  valuesPath: '/customer/settings.json'
});
assert.equal(Object.isFrozen(policy), true, 'callers must not be able to mutate the resolved policy');

const input = { action: 'compile', requested: { capability: 'shell' } };
const bounded = boundedCompileInput(input, 1000, settings(2, false));
assert.deepEqual(bounded, {
  action: 'compile',
  requested: { capability: 'shell', expiresAtMs: 121000 }
});
assert.equal(input.requested.expiresAtMs, undefined, 'bounding must not mutate the caller input');
assert.equal(Object.isFrozen(bounded.requested), true);

const tighter = boundedCompileInput(
  { requested: { capability: 'shell', expiresAtMs: 50000 } },
  1000,
  settings(2, false)
);
assert.equal(tighter.requested.expiresAtMs, 50000,
  'the policy must preserve an existing expiry that is tighter than its duration limit');

const revocations = [];
const state = {
  revokeActiveCapabilityProfiles(value) {
    revocations.push(value);
    return { revoked: 3 };
  }
};
assert.deepEqual(prepareState(state, settings(5, false)), { prepared: true, revoked: 3 });
assert.deepEqual(revocations, [{ reasonCode: RESTART_REVOCATION_REASON }]);
assert.deepEqual(prepareState(state, settings(5, false)), { prepared: true, revoked: 0 },
  'the same state must be prepared only once per process');
assert.equal(revocations.length, 1, 'repeat preparation must not revoke twice');

const survivingState = {
  revokeActiveCapabilityProfiles() {
    throw new Error('a restart-surviving policy must not revoke');
  }
};
assert.deepEqual(prepareState(survivingState, settings(5, true)), { prepared: true, revoked: 0 });

assert.throws(
  () => resolvePolicy(settings(0, false)),
  error => error instanceof CapabilityElevationPolicyError
    && error.code === 'CAPABILITY_ELEVATION_SETTINGS_INVALID'
    && Object.isFrozen(error.details),
  'invalid customer settings must fail closed with the exported typed error'
);

function refusal(operation, code, cause) {
  assert.throws(operation, error => {
    assert.equal(error instanceof CapabilityElevationPolicyError, true);
    assert.equal(error.code, code);
    if (cause !== undefined) assert.equal(error.details.cause, cause);
    return true;
  });
}

let settingsReads = 0;
refusal(
  () => boundedCompileInput({}, -1, {
    loadSettings() {
      settingsReads += 1;
      throw new Error('must not be reached');
    }
  }),
  'CAPABILITY_ELEVATION_CLOCK_INVALID'
);
assert.equal(settingsReads, 0, 'an invalid clock must refuse before reading settings or producing output');

refusal(
  () => boundedCompileInput({}, Number.MAX_SAFE_INTEGER, settings(1, false)),
  'CAPABILITY_ELEVATION_CLOCK_INVALID'
);

refusal(
  () => resolvePolicy({ loadSettings() { throw new Error('unreadable'); } }),
  'CAPABILITY_ELEVATION_SETTINGS_UNAVAILABLE',
  'SETTINGS_READ_FAILED'
);
refusal(
  () => resolvePolicy({ loadSettings: () => null }),
  'CAPABILITY_ELEVATION_SETTINGS_UNAVAILABLE',
  'SETTINGS_RESULT_INVALID'
);

refusal(
  () => prepareState(null, settings(1, false)),
  'CAPABILITY_ELEVATION_STATE_UNAVAILABLE'
);

function throwingRevocationState() {
  const calls = [];
  return {
    calls,
    state: {
      revokeActiveCapabilityProfiles(value) {
        calls.push(value);
        throw new Error('durable write failed');
      }
    }
  };
}

const failedWrite = throwingRevocationState();
refusal(
  () => prepareState(failedWrite.state, settings(1, false)),
  'CAPABILITY_ELEVATION_REVOCATION_FAILED',
  'REVOCATION_FAILED'
);
assert.deepEqual(failedWrite.calls, [{ reasonCode: RESTART_REVOCATION_REASON }],
  'a failed revocation must make exactly one write attempt');
refusal(
  () => prepareState(failedWrite.state, settings(1, false)),
  'CAPABILITY_ELEVATION_REVOCATION_FAILED',
  'REVOCATION_FAILED'
);
assert.equal(failedWrite.calls.length, 2,
  'a refused state must not be marked prepared or silently accepted on retry');

const invalidResults = [];
const invalidResultState = {
  revokeActiveCapabilityProfiles(value) {
    invalidResults.push(value);
    return { revoked: -1 };
  }
};
refusal(
  () => prepareState(invalidResultState, settings(1, false)),
  'CAPABILITY_ELEVATION_REVOCATION_FAILED',
  'REVOCATION_RESULT_INVALID'
);
assert.deepEqual(invalidResults, [{ reasonCode: RESTART_REVOCATION_REASON }]);
refusal(
  () => prepareState(invalidResultState, settings(1, false)),
  'CAPABILITY_ELEVATION_REVOCATION_FAILED',
  'REVOCATION_RESULT_INVALID'
);
assert.equal(invalidResults.length, 2,
  'an invalid revocation result must not mark the state prepared');

const doubleFailure = throwingRevocationState();
refusal(
  () => prepareState(doubleFailure.state, {
    loadSettings() { throw new Error('settings offline'); }
  }),
  'CAPABILITY_ELEVATION_REVOCATION_FAILED',
  'REVOCATION_FAILED'
);
assert.deepEqual(doubleFailure.calls, [{ reasonCode: RESTART_REVOCATION_REASON }],
  'unavailable settings must fail closed with one revocation attempt and no returned grant');

console.log('capability-elevation-policy behavioural tests passed');
