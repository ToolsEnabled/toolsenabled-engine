'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const machineRecord = require('../src/lib/setup/machine-record');

function validInput(root, tier = 'standard') {
  return {
    tier,
    installRoot: path.join(root, 'install'),
    servicesRoot: path.join(root, 'state'),
    nodePath: process.execPath,
    workspaceRoots: [path.join(root, 'workspace')],
    machineId: 'refusal-test',
    machineLabel: 'Refusal test'
  };
}

function snapshot(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).sort();
}

function assertRefusesWithoutEffects(code, root, operation) {
  const before = snapshot(root);
  let spawnCalls = 0;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawn = () => { spawnCalls += 1; throw new Error('unexpected spawn'); };
  childProcess.spawnSync = () => { spawnCalls += 1; throw new Error('unexpected spawnSync'); };
  try {
    assert.throws(operation, error => {
      assert.equal(error.name, 'SetupRefusal');
      assert.equal(error.code, code);
      return true;
    });
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }
  assert.deepEqual(snapshot(root), before, 'a refusal must not change the filesystem');
  assert.equal(spawnCalls, 0, 'a refusal must not spawn a process');
}

test('invalid input is refused before a machine record can be returned or written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-record-invalid-'));
  try {
    assertRefusesWithoutEffects('SETUP_MACHINE_RECORD_INVALID', root, () =>
      machineRecord.buildMachineRecord({ ...validInput(root), workspaceRoots: [] }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an existing machine record that cannot be read is a named refusal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-record-unreadable-'));
  try {
    const readFile = () => { const error = new Error('permission denied'); error.code = 'EACCES'; throw error; };
    assertRefusesWithoutEffects('SETUP_MACHINE_RECORD_UNREADABLE', root, () =>
      machineRecord.readMachineRecord({ servicesRoot: root, readFile }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an integrity key that cannot be read refuses verification without adopting or writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-record-key-unreadable-'));
  try {
    const servicesRoot = path.join(root, 'state');
    fs.mkdirSync(machineRecord.machineRecordKeyPath(servicesRoot), { recursive: true });
    const record = machineRecord.buildMachineRecord(validInput(root));
    assertRefusesWithoutEffects('SETUP_MACHINE_RECORD_KEY_UNREADABLE', root, () =>
      machineRecord.verifyMachineRecordIntegrity(record, { servicesRoot }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function withEmptyRegistry(run) {
  const registryPath = require.resolve('../src/lib/tool-registry');
  const previous = require.cache[registryPath];
  require.cache[registryPath] = {
    id: registryPath,
    filename: registryPath,
    loaded: true,
    exports: { registeredTools: () => [] },
    children: [],
    paths: []
  };
  try { run(); } finally {
    if (previous) require.cache[registryPath] = previous;
    else delete require.cache[registryPath];
  }
}

test('an unavailable read-only profile is refused rather than returned as an unrestricted empty list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-record-readonly-'));
  try {
    withEmptyRegistry(() => assertRefusesWithoutEffects('SETUP_READ_ONLY_PROFILE_UNAVAILABLE', root, () =>
      machineRecord.readOnlyToolAllowlist()));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unavailable limited-tier profile is refused rather than returned as an unrestricted empty list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-record-tier-'));
  try {
    withEmptyRegistry(() => assertRefusesWithoutEffects('SETUP_TIER_PROFILE_UNAVAILABLE', root, () =>
      machineRecord.tierToolAllowlist('standard')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
