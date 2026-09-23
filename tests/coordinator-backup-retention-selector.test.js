'use strict';

// Q37 retention-selector adversarial contract. Every input is inert data; the
// planner is pure and this test never creates a backup, deletes a snapshot, or
// resolves the root binding to a path.

const assert = require('node:assert/strict');
const planner = require('../src/lib/coordinator/backup-artifact-plan.js');

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
let passed = 0;
function check(name, fn) { fn(); passed += 1; process.stdout.write(`  ok  ${name}\n`); }

function input(overrides = {}) {
  return {
    rootBinding: planner.ROOT_BINDING,
    snapshotName: 'snapshot-20260730T110000Z',
    createdAt: '2026-07-30T11:00:00.000Z',
    maxSnapshots: 2,
    artifacts: [...planner.REQUIRED_ARTIFACTS],
    existingSnapshotNames: [
      'snapshot-20260727T110000Z',
      'snapshot-20260729T110000Z',
      'snapshot-20260728T110000Z'
    ],
    ...overrides
  };
}

function refuses(candidate, label, nowMs = NOW) {
  const result = planner.buildBackupArtifactPlan(candidate, nowMs);
  assert.equal(result.valid, false, label);
  assert.equal(result.plan, null, label);
  assert.equal(Object.isFrozen(result), true, label);
}

function run() {
  process.stdout.write('coordinator-backup-retention-selector\n');

  check('sorts only canonical snapshot names and returns frozen path-free retention candidates', () => {
    const result = planner.buildBackupArtifactPlan(input(), NOW);
    assert.equal(result.valid, true);
    assert.deepEqual(result.plan.retention, {
      maxSnapshots: 2,
      retainSnapshotNames: ['snapshot-20260730T110000Z', 'snapshot-20260729T110000Z'],
      pruneCandidateSnapshotNames: ['snapshot-20260728T110000Z', 'snapshot-20260727T110000Z'],
      deletionAuthorized: false
    });
    assert.equal(Object.isFrozen(result.plan.retention), true);
    assert.equal(Object.isFrozen(result.plan.retention.retainSnapshotNames), true);
    assert.equal(Object.isFrozen(result.plan.retention.pruneCandidateSnapshotNames), true);
    assert.equal(JSON.stringify(result.plan.retention).includes('\\'), false);
    assert.equal(JSON.stringify(result.plan.retention).includes('/'), false);
    assert.equal(result.plan.retention.deletionAuthorized, false);
  });

  check('rejects future names and every unsafe retention or inventory bound', () => {
    refuses(input({ snapshotName: 'snapshot-20260730T120001Z', createdAt: '2026-07-30T12:00:01.000Z' }), 'future proposed snapshot');
    refuses(input({ existingSnapshotNames: ['snapshot-20260730T120001Z'] }), 'future existing snapshot');
    refuses(input({ maxSnapshots: 0 }), 'zero retention bound');
    refuses(input({ maxSnapshots: planner.MAX_RETENTION_SNAPSHOTS + 1 }), 'oversized retention bound');
    refuses(input({ existingSnapshotNames: Array.from({ length: planner.MAX_SNAPSHOT_INVENTORY + 1 }, (_value, index) => `snapshot-20250101T${String(index % 24).padStart(2, '0')}0000Z`) }), 'oversized inventory');
  });

  check('rejects duplicate, noncanonical, path-shaped, sparse, accessor, prototype, and symbol inventory data', () => {
    refuses(input({ existingSnapshotNames: ['snapshot-20260729T110000Z', 'snapshot-20260729T110000Z'] }), 'duplicate name');
    for (const name of ['snapshot-20260729T110000Z/escape', '..\\snapshot-20260729T110000Z', 'snapshot-20260230T110000Z', 'snapshot-20260729T110000Z.']) {
      refuses(input({ existingSnapshotNames: [name] }), `unsafe name ${name}`);
    }
    const sparse = [];
    sparse.length = 1;
    refuses(input({ existingSnapshotNames: sparse }), 'sparse array');
    let accessed = 0;
    const accessor = ['snapshot-20260729T110000Z'];
    Object.defineProperty(accessor, '0', { enumerable: true, get() { accessed += 1; return 'snapshot-20260729T110000Z'; } });
    refuses(input({ existingSnapshotNames: accessor }), 'accessor array');
    assert.equal(accessed, 0, 'the selector must reject accessor inventory without evaluating it');
    const exotic = ['snapshot-20260729T110000Z'];
    Object.setPrototypeOf(exotic, null);
    refuses(input({ existingSnapshotNames: exotic }), 'nonstandard array prototype');
    const symbolized = ['snapshot-20260729T110000Z'];
    symbolized[Symbol('hidden')] = true;
    refuses(input({ existingSnapshotNames: symbolized }), 'symbol inventory property');
  });

  check('keeps the API closed against hostile time values and caller-owned result mutation', () => {
    refuses(input(), 'invalid now value', NaN);
    const result = planner.buildBackupArtifactPlan(input(), NOW);
    assert.throws(() => { result.plan.retention.pruneCandidateSnapshotNames.push('snapshot-20200101T000000Z'); }, TypeError);
    assert.equal(result.plan.retention.pruneCandidateSnapshotNames.includes('snapshot-20200101T000000Z'), false);
  });

  check('snapshots outer descriptor values without evaluating hostile proxy property reads', () => {
    const source = input();
    let reads = 0;
    const hostile = new Proxy(source, {
      get() {
        reads += 1;
        throw new Error('ordinary property reads are forbidden');
      }
    });
    const result = planner.buildBackupArtifactPlan(hostile, NOW);
    assert.equal(result.valid, true);
    assert.equal(reads, 0);
    assert.equal(result.plan.snapshotName, source.snapshotName);
  });

  check('snapshots nested array descriptors once before validation and planning', () => {
    let descriptorReads = 0;
    const names = new Proxy(['snapshot-20260729T110000Z'], {
      getOwnPropertyDescriptor(target, key) {
        if (key === '0') {
          descriptorReads += 1;
          if (descriptorReads > 1) throw new Error('stateful descriptor trap');
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    const result = planner.buildBackupArtifactPlan(input({ existingSnapshotNames: names }), NOW);
    assert.equal(result.valid, true);
    assert.equal(descriptorReads, 1);
    assert.deepEqual(result.plan.retention.retainSnapshotNames, [
      'snapshot-20260730T110000Z',
      'snapshot-20260729T110000Z'
    ]);
  });

  process.stdout.write(`\ncoordinator-backup-retention-selector: ${passed} checks passed\n`);
}

try { run(); } catch (error) { process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`); process.exitCode = 1; }
