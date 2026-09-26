/*
 * Mutation check: changed deletionAuthorized from false to true in backup-artifact-plan.js.
 * The edit landed: yes (the mutated line was printed before the isolated run).
 * The isolated test went red: yes (exit code 1 on the retention deep-equality assertion).
 */
'use strict';

const assert = require('node:assert/strict');
const planner = require('../src/lib/coordinator/backup-artifact-plan.js');

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

function validInput(overrides = {}) {
  return {
    rootBinding: planner.ROOT_BINDING,
    snapshotName: 'snapshot-20260827T120000Z',
    createdAt: '2026-08-27T12:00:00.000Z',
    maxSnapshots: 2,
    artifacts: [...planner.REQUIRED_ARTIFACTS],
    existingSnapshotNames: [
      'snapshot-20260825T120000Z',
      'snapshot-20260826T120000Z',
      'snapshot-20260824T120000Z'
    ],
    ...overrides
  };
}

function run() {
  assert.equal(planner.snapshotIso('snapshot-20260827T120000Z'), '2026-08-27T12:00:00.000Z');
  assert.equal(planner.snapshotIso('snapshot-20260230T120000Z'), null);

  assert.equal(planner.validateInput(validInput(), NOW), null);
  const invalid = planner.validateInput(validInput({ rootBinding: 'unapproved-root' }), NOW);
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors, ['rootBinding is not the fixed approved backup root']);

  const result = planner.buildBackupArtifactPlan(validInput(), NOW);
  assert.equal(result.valid, true);
  assert.deepEqual(result.plan.retention, {
    maxSnapshots: 2,
    retainSnapshotNames: [
      'snapshot-20260827T120000Z',
      'snapshot-20260826T120000Z'
    ],
    pruneCandidateSnapshotNames: [
      'snapshot-20260825T120000Z',
      'snapshot-20260824T120000Z'
    ],
    deletionAuthorized: false
  });
  assert.deepEqual(result.plan.manifest.artifacts, [
    { name: 'repo.bundle', materialized: false, contentHash: 'not-produced' },
    { name: 'vault-state.enc', materialized: false, contentHash: 'not-produced' }
  ]);
  assert.equal(result.plan.activation.writesAuthorized, false);
  assert.equal(Object.isFrozen(result.plan.retention.retainSnapshotNames), true);

  process.stdout.write('coordinator-backup-artifact-plan-firsttest2: ok\n');
}

try {
  run();
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}
