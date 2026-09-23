'use strict';

const assert = require('node:assert/strict');
const migration = require('../../src/lib/build-queue-migration');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}
function expectCode(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}

const fixture = [
  '# Queue', '',
  '## Q1 — Alpha', '',
  '**Status:** OPEN planned', '',
  '**Authority:** R1 (directiveId: alpha)', '',
  '**Build:**', 'Keep exact α bytes.', '', '---', '',
  '## Q2 - Beta', '',
  '**Status:** PARTIAL started', '',
  '**Authority:** R2 (directiveId: beta)', '',
  '**Build:**', 'CRLF follows.\r\nSecond line.', '', '---', '',
  '## Completed', '',
  '- **Q9:** DONE', '',
  '## Q3 — Gamma', '',
  '**Status:** DONE', '',
  '**Authority:** R3 (directiveId: gamma)', '',
  '**Build:**', 'Terminal body.'
].join('\n');

check('split requires explicit ownership for every phase', () => {
  expectCode(() => migration.splitQueueMigration({ queueMarkdown: fixture, assignments: { 'fleet.queue': ['Q1'] } }), 'QUEUE_MIGRATION_ROOT_PHASES_INVALID');
  expectCode(() => migration.splitQueueMigration({ queueMarkdown: fixture, assignments: { 'fleet.queue': ['Q1'] }, rootPhaseIds: ['Q2'] }), 'QUEUE_MIGRATION_PHASES_UNASSIGNED');
});

check('split emits package Markdown and a marker-bearing root without guessing', () => {
  const result = migration.splitQueueMigration({
    queueMarkdown: fixture,
    assignments: { 'fleet.queue': ['Q1'], 'owner.ledger': ['Q2'] },
    rootPhaseIds: ['Q3']
  });
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.phaseOrder, ['Q1', 'Q2', 'Q3']);
  assert.deepEqual(result.rootPhaseIds, ['Q3']);
  assert.match(result.rootMarkdown, /build-queue-slice:v1 phase=Q1 package=fleet\.queue/);
  assert.match(result.rootMarkdown, /## Package queue index/);
  assert.match(result.rootMarkdown, /`owner\.ledger`: \[queue\/owner\.ledger\.md\]/);
  assert.match(result.rootMarkdown, /## Completed/);
  assert.match(result.slices['owner.ledger'], /CRLF follows\.\r\nSecond line/);
  assert.equal(result.rootMarkdown.includes('Keep exact α bytes.'), false);
});

check('merge reconstitutes the original queue byte-for-byte', () => {
  const result = migration.splitQueueMigration({
    queueMarkdown: fixture,
    assignments: { 'fleet.queue': ['Q1'], 'owner.ledger': ['Q2'] },
    rootPhaseIds: ['Q3']
  });
  const merged = migration.mergeQueueMigration(result);
  assert.equal(merged, fixture);
});

check('tampered, missing, extra, and duplicate slice material fail closed', () => {
  const result = migration.splitQueueMigration({
    queueMarkdown: fixture,
    assignments: { 'fleet.queue': ['Q1'], 'owner.ledger': ['Q2'] },
    rootPhaseIds: ['Q3']
  });
  expectCode(() => migration.mergeQueueMigration({ ...result, slices: { 'fleet.queue': result.slices['fleet.queue'] } }), 'QUEUE_MIGRATION_SLICE_SET_INVALID');
  expectCode(() => migration.mergeQueueMigration({ ...result, slices: { ...result.slices, 'extra.pkg': result.slices['fleet.queue'] } }), 'QUEUE_MIGRATION_SLICE_SET_INVALID');
  expectCode(() => migration.mergeQueueMigration({ ...result, slices: { ...result.slices, 'fleet.queue': result.slices['fleet.queue'].replace('Alpha', 'Tampered') } }), 'QUEUE_MIGRATION_HASH_MISMATCH');
  const marker = '<!-- build-queue-slice:v1 phase=Q1 package=fleet.queue -->\n';
  expectCode(() => migration.mergeQueueMigration({ ...result, rootMarkdown: result.rootMarkdown.replace(marker, marker + marker) }), 'QUEUE_MIGRATION_MARKER_DUPLICATE');
  expectCode(() => migration.mergeQueueMigration({ rootMarkdown: result.rootMarkdown, slices: result.slices }), 'QUEUE_MIGRATION_SOURCE_RECEIPT_REQUIRED');

  const duplicateAcrossPackages = {
    ...result,
    rootMarkdown: result.rootMarkdown.replace(
      '- `owner.ledger`: [queue/owner.ledger.md](queue/owner.ledger.md)',
      '- `owner.ledger`: [queue/owner.ledger.md](queue/owner.ledger.md)\n- `third.pkg`: [queue/third.pkg.md](queue/third.pkg.md)'
    ),
    slices: { ...result.slices, 'third.pkg': result.slices['fleet.queue'] }
  };
  expectCode(() => migration.mergeQueueMigration(duplicateAcrossPackages), 'QUEUE_MIGRATION_PHASE_COLLISION');
});

check('slice ownership collisions and unsafe package ids are rejected', () => {
  expectCode(() => migration.splitQueueMigration({ queueMarkdown: fixture, assignments: { 'fleet.queue': ['Q1'], 'owner.ledger': ['Q1', 'Q2'] }, rootPhaseIds: ['Q3'] }), 'QUEUE_SLICE_PHASE_COLLISION');
  expectCode(() => migration.splitQueueMigration({ queueMarkdown: fixture, assignments: { 'bad/pkg': ['Q1', 'Q2'] }, rootPhaseIds: ['Q3'] }), 'QUEUE_SLICE_PACKAGE_INVALID');
});

console.log(`build-queue-migration: ${checks} checks passed`);
