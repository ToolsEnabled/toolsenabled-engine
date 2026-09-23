'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const confinement = require('../src/lib/agent-session-confinement');
const settings = require('../src/lib/settings');

const TIER_ID = 'capability.tier';
const ROOTS_ID = 'capability.workspace_roots';

function registry() {
  const entries = [
    { id: TIER_ID, control: 'readback', default: 'not-authority' },
    { id: ROOTS_ID, control: 'readback', default: ['/not-authority'] }
  ];
  return { entries, byId: new Map(entries.map(entry => [entry.id, entry])) };
}

function fixture(t, readMachineRecord) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-machine-refusal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const valuesPath = path.join(directory, 'settings.json');
  const originalSettings = '{"sentinel":"must-not-be-written"}\n';
  fs.writeFileSync(valuesPath, originalSettings);
  const calls = [];
  const machineRecord = {
    resolveServicesRoot: () => { throw new Error('injected servicesRoot must be used'); },
    machineRecordPath: root => {
      calls.push(['path', root]);
      return path.join(root, 'machine.json');
    },
    readMachineRecord: options => {
      calls.push(['read', options]);
      return readMachineRecord();
    }
  };
  return { directory, valuesPath, originalSettings, calls, machineRecord };
}

function assertNoEffects(f) {
  assert.equal(fs.readFileSync(f.valuesPath, 'utf8'), f.originalSettings,
    'resolving a refusal must not rewrite settings.json');
  assert.deepEqual(f.calls, [
    ['path', f.directory],
    ['read', { servicesRoot: f.directory }]
  ], 'the refusal path only locates and reads machine.json; it performs no writer/spawner call');
}

function assertFailedClosed(result, reason) {
  assert.equal(result.values[TIER_ID], confinement.FAIL_CLOSED_TIER);
  assert.deepEqual(result.values[ROOTS_ID], []);
  for (const id of [TIER_ID, ROOTS_ID]) {
    assert.equal(result.readbacks[id].status, 'failed-closed');
    assert.equal(result.readbacks[id].reason, reason);
  }
}

test('a missing machine record reaches SETUP_MACHINE_RECORD_ABSENT and fails closed without effects', (t) => {
  const f = fixture(t, () => null);
  const result = settings.loadSettings({
    registry: registry(), valuesPath: f.valuesPath,
    machineRecord: f.machineRecord, servicesRoot: f.directory
  });
  assertFailedClosed(result, 'SETUP_MACHINE_RECORD_ABSENT');
  assertNoEffects(f);
});

test('a record without usable roots reaches SETUP_MACHINE_RECORD_INVALID and fails closed without effects', (t) => {
  const f = fixture(t, () => ({ tier: 'guided', workspaceRoots: [] }));
  const result = settings.loadSettings({
    registry: registry(), valuesPath: f.valuesPath,
    machineRecord: f.machineRecord, servicesRoot: f.directory
  });
  assertFailedClosed(result, 'SETUP_MACHINE_RECORD_INVALID');
  assertNoEffects(f);
});

test('SETUP_MACHINE_RECORD_UNREADABLE is indeterminate, throws, and performs no effects', (t) => {
  const cause = Object.assign(new Error('injected unreadable authority'), {
    code: 'SETUP_MACHINE_RECORD_UNREADABLE'
  });
  const f = fixture(t, () => { throw cause; });
  assert.throws(() => settings.loadSettings({
    registry: registry(), valuesPath: f.valuesPath,
    machineRecord: f.machineRecord, servicesRoot: f.directory
  }), error => {
    assert.equal(error.code, 'SETTINGS_MACHINE_RECORD_UNAVAILABLE');
    assert.equal(error.cause, cause);
    return true;
  });
  assertNoEffects(f);
});
