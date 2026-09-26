'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

let writes = 0;
let spawns = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;

fs.writeFileSync = function monitoredWriteFileSync(...args) {
  writes += 1;
  return originalWriteFileSync.apply(this, args);
};
fs.appendFileSync = function monitoredAppendFileSync(...args) {
  writes += 1;
  return originalAppendFileSync.apply(this, args);
};
childProcess.spawn = function monitoredSpawn(...args) {
  spawns += 1;
  return originalSpawn.apply(this, args);
};
childProcess.spawnSync = function monitoredSpawnSync(...args) {
  spawns += 1;
  return originalSpawnSync.apply(this, args);
};

try {
  const { MissionBridgeError, typedError } = require('../src/lib/mission-bridge/errors');
  const dependencyFailure = {
    code: 'ACCOUNT_UNAUTHORIZED',
    message: 'The selected account is not authorized for this operation.',
    details: { account: 'work' }
  };

  const refusal = typedError(dependencyFailure);

  assert.ok(refusal instanceof MissionBridgeError, 'typedError returns the bridge error callers handle');
  assert.equal(refusal.code, 'ACCOUNT_UNAUTHORIZED', 'the reachable UNAUTH code is retained');
  assert.equal(refusal.status, 401, 'an UNAUTH dependency refusal is classified as unauthorized');
  assert.equal(refusal.message, dependencyFailure.message, 'the actionable refusal reason accompanies the code');
  assert.deepEqual(refusal.details, dependencyFailure.details, 'structured refusal details accompany the code');
  assert.equal(writes, 0, 'classifying the refusal does not write a file');
  assert.equal(spawns, 0, 'classifying the refusal does not spawn a process');
} finally {
  fs.writeFileSync = originalWriteFileSync;
  fs.appendFileSync = originalAppendFileSync;
  childProcess.spawn = originalSpawn;
  childProcess.spawnSync = originalSpawnSync;
}

console.log('mission-bridge errors UNAUTH refusal: driven');
