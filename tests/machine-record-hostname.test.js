'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const machineRecord = require('../src/lib/setup/machine-record');

test('hostname read failures are not latched as a definite fallback machine identity', () => {
  for (const causeCode of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    const unavailable = () => {
      throw Object.assign(new Error(`hostname read failed with ${causeCode}`), { code: causeCode });
    };

    assert.throws(
      () => machineRecord.defaultMachineId(unavailable),
      error => error.code === 'SETUP_MACHINE_ID_UNAVAILABLE' &&
        error.details.causeCode === causeCode &&
        error.message.includes('does not mean the computer has no name'),
      `${causeCode} must not become the permanent identity "this-machine"`
    );
    assert.throws(
      () => machineRecord.defaultMachineLabel(unavailable),
      error => error.code === 'SETUP_MACHINE_LABEL_UNAVAILABLE' &&
        error.details.causeCode === causeCode &&
        error.message.includes('does not mean the computer has no name'),
      `${causeCode} must not become the permanent label "This computer"`
    );
  }

  // CONTROL: genuine, successfully read values still become the stable values
  // copied into the immutable machine record; refusing uncertainty must not
  // remove the persistence that keeps setup from re-probing a known identity.
  let hostname = 'Build-Agent-07';
  const provider = () => hostname;
  const record = machineRecord.buildMachineRecord({
    tier: 'guided',
    installRoot: __dirname,
    servicesRoot: __dirname,
    nodePath: process.execPath,
    workspaceRoots: [__dirname],
    machineId: machineRecord.defaultMachineId(provider),
    machineLabel: machineRecord.defaultMachineLabel(provider)
  });
  hostname = 'Build-Agent-08';
  assert.deepEqual(record.machine, { id: 'build-agent-07', label: 'Build-Agent-07' });
  assert.equal(Object.isFrozen(record.machine), true);

  // An empty but successfully read hostname remains the legitimate neutral
  // fallback. Only a failed read is "could not tell".
  assert.equal(machineRecord.defaultMachineId(() => ''), 'this-machine');
  assert.equal(machineRecord.defaultMachineLabel(() => ''), 'This computer');
});
