'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const contract = require('../src/lib/build-queue-package-contract');

const manifest = {
  schemaVersion: 1,
  packages: [
    { id: 'fleet.queue', files: ['src/fleet.js'] },
    { id: 'owner.ledger', files: ['src/ledger.js'] }
  ]
};

function expectRefusalWithoutEffects(fn, code) {
  const calls = [];
  const sentinels = [
    [fs, 'appendFileSync'],
    [fs, 'mkdirSync'],
    [fs, 'renameSync'],
    [fs, 'writeFileSync'],
    [childProcess, 'exec'],
    [childProcess, 'execSync'],
    [childProcess, 'spawn'],
    [childProcess, 'spawnSync']
  ];
  const originals = sentinels.map(([owner, name]) => [owner, name, owner[name]]);
  for (const [owner, name] of sentinels) owner[name] = (...args) => { calls.push({ name, args }); };
  try {
    assert.throws(fn, candidate => candidate instanceof contract.QueuePackageContractError && candidate.code === code);
  } finally {
    for (const [owner, name, original] of originals) owner[name] = original;
  }
  assert.deepEqual(calls, [], `${code} must refuse before writing or spawning`);
}

expectRefusalWithoutEffects(
  () => contract.buildQueueSliceIndex({ manifest: { schemaVersion: 1, packages: [] }, assignments: {} }),
  'QUEUE_PACKAGE_MANIFEST_INVALID'
);

expectRefusalWithoutEffects(
  () => contract.validateQueueSliceIndex({ manifest, index: { schemaVersion: 1, queueDirectory: 'queue' } }),
  'QUEUE_PACKAGE_INDEX_INVALID'
);

expectRefusalWithoutEffects(
  () => contract.buildQueueSliceIndex({ manifest, assignments: { 'fleet.queue': ['Q1', 'Q1'] } }),
  'QUEUE_PACKAGE_PHASE_IDS_DUPLICATE'
);

expectRefusalWithoutEffects(
  () => contract.validateQueueSliceIndex({
    manifest,
    index: {
      schemaVersion: 1,
      queueDirectory: 'queue',
      slices: [
        { packageId: 'fleet.queue', path: 'queue/fleet.queue.md', phaseIds: ['Q1'] },
        { packageId: 'fleet.queue', path: 'queue/fleet.queue.md', phaseIds: ['Q2'] }
      ]
    }
  }),
  'QUEUE_PACKAGE_SLICE_DUPLICATE'
);

console.log('build-queue-package-contract refusals: 4 driven refusals passed');
