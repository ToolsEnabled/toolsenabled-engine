'use strict';

require('./lib/isolated-environment').activate('reminders-refusals');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

// The supported runtime includes node:sqlite. This refusal test injects state and
// deliberately prevents the environment's older Node from initializing the
// unused default store.
const stateStorePath = require.resolve('../src/lib/state-store');
require.cache[stateStorePath] = {
  id: stateStorePath, filename: stateStorePath, loaded: true,
  exports: { getStateStore() { throw new Error('unexpected default state store'); } }
};
const reminders = require('../src/lib/providers/reminders');

const existingId = 'reminder-11111111-1111-4111-8111-111111111111';
const missingId = 'reminder-22222222-2222-4222-8222-222222222222';

function refusalHarness(entries = new Map()) {
  const effects = [];
  const state = {
    getMemory({ namespace, key }) {
      assert.equal(namespace, reminders.NAMESPACE);
      effects.push(`read:${key}`);
      return entries.get(key) || null;
    },
    setMemory() { effects.push('write:setMemory'); throw new Error('unexpected write'); },
    deleteMemory() { effects.push('write:deleteMemory'); throw new Error('unexpected delete'); },
    searchMemory() { effects.push('write:searchMemory'); throw new Error('unexpected search'); }
  };
  return { effects, state };
}

function withSpawnTripwires(operation) {
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const spawned = [];
  childProcess.spawn = (...args) => { spawned.push(['spawn', ...args]); throw new Error('unexpected spawn'); };
  childProcess.spawnSync = (...args) => { spawned.push(['spawnSync', ...args]); throw new Error('unexpected spawn'); };
  try {
    operation();
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }
  assert.deepEqual(spawned, [], 'a refused reminder operation must not spawn a process');
}

const existingEntry = {
  key: existingId,
  value: {
    type: 'reminder', title: 'Already stored', recurrence: 'none', status: 'active',
    createdAt: '2026-08-27T00:00:00.000Z'
  },
  revision: 1,
  updatedAt: '2026-08-27T00:00:00.000Z',
  valueHash: 'existing-hash'
};

{
  const harness = refusalHarness(new Map([[existingId, existingEntry]]));
  withSpawnTripwires(() => {
    assert.throws(
      () => reminders.create({ reminderId: existingId, title: 'Replacement' }, { state: harness.state }),
      error => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.code, 'REMINDER_EXISTS');
        assert.equal(error.message, 'A reminder with this ID already exists.');
        assert.deepEqual(error.details, { reminderId: existingId });
        return true;
      }
    );
  });
  assert.deepEqual(harness.effects, [`read:${existingId}`], 'duplicate refusal must only read the existing reminder');
}

{
  const harness = refusalHarness();
  withSpawnTripwires(() => {
    assert.throws(
      () => reminders.complete({ reminderId: missingId }, { state: harness.state }),
      error => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.code, 'REMINDER_NOT_FOUND');
        assert.equal(error.message, 'Reminder was not found.');
        assert.deepEqual(error.details, { reminderId: missingId });
        return true;
      }
    );
  });
  assert.deepEqual(harness.effects, [`read:${missingId}`], 'missing refusal must only read the requested reminder');
}

console.log('Reminder refusal tests passed.');
