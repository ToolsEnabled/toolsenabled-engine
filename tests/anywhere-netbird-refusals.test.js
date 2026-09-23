'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const netbird = require('../src/lib/anywhere-netbird');

const VALID_KEY = 'A1B2C3D4-1111-2222-3333-444455556666';
let checks = 0;
let writes = 0;
let spawns = 0;

// These refusals happen before a caller is allowed to act on a descriptor,
// enrollment receipt, or retry schedule. Guard that boundary explicitly: a
// future implementation must not persist partial state or launch a client on
// an input it subsequently refuses.
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;

fs.writeFileSync = function observedWriteFileSync(...args) {
  writes += 1;
  return originalWriteFileSync.apply(this, args);
};
fs.appendFileSync = function observedAppendFileSync(...args) {
  writes += 1;
  return originalAppendFileSync.apply(this, args);
};
childProcess.spawn = function observedSpawn(...args) {
  spawns += 1;
  return originalSpawn.apply(this, args);
};
childProcess.spawnSync = function observedSpawnSync(...args) {
  spawns += 1;
  return originalSpawnSync.apply(this, args);
};

function check(label, fn) {
  const writesBefore = writes;
  const spawnsBefore = spawns;
  fn();
  assert.equal(writes, writesBefore, `${label}: refusal must not write anything`);
  assert.equal(spawns, spawnsBefore, `${label}: refusal must not spawn anything`);
  checks += 1;
}

try {
  check('missing management endpoint', () => {
    let returned = false;
    assert.throws(
      () => {
        netbird.describeDeployment({ transport: netbird.TRANSPORT_SELF_HOSTED });
        returned = true;
      },
      error => {
        assert.ok(error instanceof netbird.AnywhereNetbirdError);
        assert.equal(error.code, 'ANYWHERE_NETBIRD_ENDPOINT_MISSING');
        assert.deepEqual(error.details, { field: 'management' });
        return true;
      }
    );
    assert.equal(returned, false, 'a missing endpoint must not produce a partial descriptor');
  });

  check('invalid enrollment hostname', () => {
    const deployment = netbird.describeDeployment({
      transport: netbird.TRANSPORT_HOSTED,
      management: 'https://management.example.test'
    });
    let receipt;
    assert.throws(
      () => { receipt = netbird.prepareEnrollment({ deployment, setupKey: VALID_KEY, hostname: '   ' }); },
      error => {
        assert.ok(error instanceof netbird.AnywhereNetbirdError);
        assert.equal(error.code, 'ANYWHERE_NETBIRD_HOSTNAME_INVALID');
        return true;
      }
    );
    assert.equal(receipt, undefined, 'an invalid hostname must not produce an enrollment receipt');
  });

  check('non-finite reconnect jitter', () => {
    const policy = netbird.createReconnectPolicy({ jitter: () => Number.NaN });
    let schedule;
    assert.throws(
      () => { schedule = policy.nextReconnect(1000, 'connection lost'); },
      error => {
        assert.ok(error instanceof netbird.AnywhereNetbirdError);
        assert.equal(error.code, 'ANYWHERE_NETBIRD_RECONNECT_JITTER_INVALID');
        assert.deepEqual(error.details, { attempt: 1 });
        return true;
      }
    );
    assert.equal(schedule, undefined, 'invalid jitter must not produce a retry schedule');
    assert.deepEqual(policy.snapshot(), {
      schemaVersion: 'anywhere-netbird-reconnect.v1',
      state: 'refused',
      attempt: 1,
      networkGeneration: 0,
      lastReason: 'connection lost',
      baseMs: 1000,
      maxMs: 60000,
      maxAttempts: 0,
      secretValuesEmitted: false
    });
  });
} finally {
  fs.writeFileSync = originalWriteFileSync;
  fs.appendFileSync = originalAppendFileSync;
  childProcess.spawn = originalSpawn;
  childProcess.spawnSync = originalSpawnSync;
}

console.log(`anywhere-netbird-refusals: ${checks} checks, 0 failures`);
