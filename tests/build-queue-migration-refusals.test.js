'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const migration = require('../src/lib/build-queue-migration');

const queueMarkdown = [
  '# Queue', '',
  '## Q1 — Alpha', '',
  '**Status:** OPEN', '',
  '**Build:**', 'Alpha body.', '',
  '## Q2 — Beta', '',
  '**Status:** DONE', '',
  '**Build:**', 'Beta body.', ''
].join('\n');

let checks = 0;
let writes = 0;
let spawns = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalSpawnSync = childProcess.spawnSync;
fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };

function split() {
  return migration.splitQueueMigration({
    queueMarkdown,
    assignments: { 'alpha.pkg': ['Q1'] },
    rootPhaseIds: ['Q2']
  });
}

function refusal(name, code, invoke, inputs = []) {
  const snapshots = inputs.map(value => JSON.stringify(value));
  const writesBefore = writes;
  const spawnsBefore = spawns;
  assert.throws(invoke, error => error && error.code === code, `${name} must throw ${code}`);
  assert.equal(writes, writesBefore, `${name} must not write a file`);
  assert.equal(spawns, spawnsBefore, `${name} must not spawn a process`);
  inputs.forEach((value, index) => assert.equal(JSON.stringify(value), snapshots[index], `${name} must not mutate input ${index}`));
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

try {
  refusal('non-text queue', 'QUEUE_MIGRATION_QUEUE_INVALID',
    () => migration.splitQueueMigration({ queueMarkdown: null, assignments: {}, rootPhaseIds: [] }));
  refusal('non-plain assignments', 'QUEUE_MIGRATION_ASSIGNMENTS_INVALID',
    () => migration.splitQueueMigration({ queueMarkdown, assignments: [], rootPhaseIds: [] }));
  const emptyAssignments = {};
  refusal('empty assignments', 'QUEUE_MIGRATION_ASSIGNMENTS_EMPTY',
    () => migration.splitQueueMigration({ queueMarkdown, assignments: emptyAssignments, rootPhaseIds: ['Q1', 'Q2'] }), [emptyAssignments]);
  const duplicateRoots = ['Q2', 'Q2'];
  refusal('duplicate root phases', 'QUEUE_MIGRATION_ROOT_PHASES_DUPLICATE',
    () => migration.splitQueueMigration({ queueMarkdown, assignments: { 'alpha.pkg': ['Q1'] }, rootPhaseIds: duplicateRoots }), [duplicateRoots]);

  refusal('non-text root', 'QUEUE_MIGRATION_ROOT_INVALID',
    () => migration.mergeQueueMigration({ rootMarkdown: null, slices: {} }));
  refusal('non-plain slices', 'QUEUE_MIGRATION_SLICES_INVALID',
    () => migration.mergeQueueMigration({ rootMarkdown: '', slices: [] }));

  const baseline = split();
  const emptySlice = { ...baseline, slices: { 'alpha.pkg': '' } };
  refusal('empty package slice', 'QUEUE_MIGRATION_SLICE_EMPTY',
    () => migration.mergeQueueMigration(emptySlice), [emptySlice]);

  const marker = '<!-- build-queue-slice:v1 phase=Q1 package=alpha.pkg -->\n';
  const noMarkers = { ...baseline, rootMarkdown: baseline.rootMarkdown.replace(marker, '') };
  refusal('root without markers', 'QUEUE_MIGRATION_MARKERS_MISSING',
    () => migration.mergeQueueMigration(noMarkers), [noMarkers]);

  const wrongPhaseSlice = {
    ...baseline,
    slices: { 'alpha.pkg': baseline.slices['alpha.pkg'].replace('Q1', 'Q2') }
  };
  refusal('marker phase absent from its slice', 'QUEUE_MIGRATION_PHASE_MISSING',
    () => migration.mergeQueueMigration(wrongPhaseSlice), [wrongPhaseSlice]);

  const extraPhase = {
    ...baseline,
    slices: { 'alpha.pkg': baseline.slices['alpha.pkg'] + baseline.rootMarkdown.slice(baseline.rootMarkdown.indexOf('## Q2')) }
  };
  refusal('slice phase without a marker', 'QUEUE_MIGRATION_SLICE_EXTRA',
    () => migration.mergeQueueMigration(extraPhase), [extraPhase]);

  const wrongByteReceipt = { ...baseline, sourceBytes: baseline.sourceBytes + 1 };
  refusal('byte receipt mismatch', 'QUEUE_MIGRATION_BYTE_MISMATCH',
    () => migration.mergeQueueMigration(wrongByteReceipt), [wrongByteReceipt]);
} finally {
  fs.writeFileSync = originalWriteFileSync;
  childProcess.spawnSync = originalSpawnSync;
}

console.log(`build-queue-migration-refusals: ${checks} driven refusals passed`);
