'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contract = require('../src/lib/build-queue-package-contract');

function expectCode(fn, code) { assert.throws(fn, error => error && error.code === code); }

const fixtureManifest = {
  schemaVersion: 1,
  packages: [
    { id: 'fleet.queue', files: ['src/fleet.js', 'tools/fleet.js'] },
    { id: 'owner.ledger', files: ['src/ledger.js'] }
  ]
};

{
  const current = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'packages.json'), 'utf8'));
  const verdict = contract.validatePackageManifest(current);
  assert.equal(verdict.valid, true, verdict.errors.join('; '));
  assert.equal(verdict.manifest.packages.length, current.packages.length);
  assert.ok(Object.isFrozen(verdict.manifest));
  assert.ok(Object.isFrozen(verdict.manifest.packages));
}

{
  assert.equal(contract.queueSlicePath('owner.ledger'), 'queue/owner.ledger.md');
  expectCode(() => contract.queueSlicePath('../owner'), 'QUEUE_PACKAGE_ID_INVALID');
  expectCode(() => contract.queueSlicePath('Owner.Ledger'), 'QUEUE_PACKAGE_ID_INVALID');
  expectCode(() => contract.queueSlicePath('owner/ledger'), 'QUEUE_PACKAGE_ID_INVALID');
}

{
  const index = contract.buildQueueSliceIndex({
    manifest: fixtureManifest,
    assignments: { 'owner.ledger': ['Q12', 'Q2'], 'fleet.queue': ['Q1'] }
  });
  assert.deepEqual(index.slices, [
    { packageId: 'fleet.queue', path: 'queue/fleet.queue.md', phaseIds: ['Q1'] },
    { packageId: 'owner.ledger', path: 'queue/owner.ledger.md', phaseIds: ['Q2', 'Q12'] }
  ]);
  assert.deepEqual(contract.validateQueueSliceIndex({ manifest: fixtureManifest, index }), index);
  assert.ok(Object.isFrozen(index));
  assert.ok(Object.isFrozen(index.slices));
}

{
  expectCode(() => contract.buildQueueSliceIndex({ manifest: fixtureManifest, assignments: { 'missing.package': ['Q1'] } }), 'QUEUE_PACKAGE_UNKNOWN');
  expectCode(() => contract.buildQueueSliceIndex({ manifest: fixtureManifest, assignments: { 'fleet.queue': ['Q1'], 'owner.ledger': ['Q1'] } }), 'QUEUE_PACKAGE_PHASE_COLLISION');
  expectCode(() => contract.buildQueueSliceIndex({ manifest: fixtureManifest, assignments: { 'fleet.queue': ['Q0'] } }), 'QUEUE_PACKAGE_PHASE_IDS_INVALID');
  expectCode(() => contract.validateQueueSliceIndex({ manifest: fixtureManifest, index: { schemaVersion: 1, queueDirectory: 'queue', slices: [{ packageId: 'fleet.queue', path: 'queue/other.md', phaseIds: ['Q1'] }] } }), 'QUEUE_PACKAGE_SLICE_PATH_INVALID');
}

{
  for (const candidate of [
    { schemaVersion: 1, packages: [{ id: 'fleet.queue', files: ['../outside.js'] }] },
    { schemaVersion: 1, packages: [{ id: 'fleet.queue', files: ['C:/outside.js'] }] },
    { schemaVersion: 1, packages: [{ id: 'fleet.queue', files: ['src/a.js'] }, { id: 'fleet.queue', files: ['src/b.js'] }] },
    { schemaVersion: 1, packages: [{ id: 'fleet.queue', files: ['src/a.js'] }, { id: 'owner.ledger', files: ['src/a.js'] }] },
    { schemaVersion: 2, packages: [{ id: 'fleet.queue', files: ['src/a.js'] }] }
  ]) assert.equal(contract.validatePackageManifest(candidate).valid, false);
}

{
  let accessed = 0;
  const hostile = { ...fixtureManifest };
  Object.defineProperty(hostile, 'packages', { enumerable: true, get() { accessed += 1; return fixtureManifest.packages; } });
  assert.equal(contract.validatePackageManifest(hostile).valid, false);
  assert.equal(accessed, 0);
  expectCode(() => contract.buildQueueSliceIndex({ manifest: fixtureManifest, assignments: Object.create(null) }), 'QUEUE_PACKAGE_ASSIGNMENTS_INVALID');
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-queue-package-contract-'));
  const queueFile = path.join(root, 'BUILD-QUEUE.md');
  const manifestFile = path.join(root, 'packages.json');
  const queueBefore = '# BUILD-QUEUE\n\n## Q1 \u2014 Fixture\n\n**Status:** OPEN\n';
  const manifestBefore = `${JSON.stringify(fixtureManifest, null, 2)}\n`;
  fs.writeFileSync(queueFile, queueBefore, 'utf8');
  fs.writeFileSync(manifestFile, manifestBefore, 'utf8');
  try {
    contract.buildQueueSliceIndex({ manifest: fixtureManifest, assignments: { 'fleet.queue': ['Q1'] } });
    assert.equal(fs.readFileSync(queueFile, 'utf8'), queueBefore, 'index construction never mutates caller-adjacent queue state');
    assert.equal(fs.readFileSync(manifestFile, 'utf8'), manifestBefore, 'index construction never mutates caller-adjacent manifest state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('build-queue-package-contract: 6 contract groups passed');
