'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const registry = require('../src/lib/service-registry');

function refuseInvalidMachineIdWithoutEffects(machineId) {
  let writes = 0;
  let spawns = 0;
  const originalWriteFileSync = fs.writeFileSync;
  const originalAppendFileSync = fs.appendFileSync;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;

  fs.writeFileSync = () => { writes += 1; };
  fs.appendFileSync = () => { writes += 1; };
  childProcess.spawn = () => { spawns += 1; };
  childProcess.spawnSync = () => { spawns += 1; };

  try {
    assert.throws(
      () => registry.machineForId(machineId),
      error => {
        assert.ok(error instanceof registry.ServiceRegistryError);
        assert.equal(error.code, 'SERVICE_MACHINE_ID_INVALID');
        assert.equal(error.message, 'Machine id must be a non-empty string.');
        return true;
      }
    );
    assert.equal(writes, 0, 'an invalid machine id must not write a file');
    assert.equal(spawns, 0, 'an invalid machine id must not spawn a process');
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.appendFileSync = originalAppendFileSync;
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }
}

for (const invalidMachineId of ['', null, undefined, 0, false, {}, []]) {
  refuseInvalidMachineIdWithoutEffects(invalidMachineId);
}

process.stdout.write('Service registry refusal tests passed.\n');
