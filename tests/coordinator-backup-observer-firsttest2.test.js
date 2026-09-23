/*
 * Mutation check: changed `namedAtMs > latestMs` to `namedAtMs < latestMs`
 * in backup-observer.js so observation would choose the oldest snapshot.
 * The edit landed: yes.
 * This isolated test went red: yes (exit 1, lastBackupAt mismatch).
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const observer = require('../src/lib/coordinator/backup-observer.js');

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const ROOT = path.resolve('/virtual/backup-destination');

function metadata(mtimeMs = NOW) {
  return {
    mtimeMs,
    isDirectory: () => true,
    isSymbolicLink: () => false
  };
}

function fakeFs(names) {
  return {
    lstatSync(candidate) {
      assert.ok(candidate === ROOT || candidate.startsWith(`${ROOT}${path.sep}`));
      return metadata();
    },
    opendirSync(candidate) {
      assert.equal(candidate, ROOT);
      let index = 0;
      return {
        readSync() {
          if (index === names.length) return null;
          const name = names[index++];
          return { name, isDirectory: () => true };
        },
        closeSync() {}
      };
    }
  };
}

function run() {
  // Exercise the exported name helpers with fixed values rather than deriving
  // expectations from the module's own regular expression or parser.
  assert.equal(observer.snapshotTimestampMs('snapshot-20240229T235959Z'), 1709251199000);
  assert.equal(observer.snapshotTimestampMs('snapshot-20230229T235959Z'), null);
  assert.equal(observer.snapshotTimestampMs('snapshot-20240827T120000Z-extra'), null);
  assert.equal(observer.isCanonicalSnapshotName('snapshot-20260827T115959Z'), true);
  assert.equal(observer.isCanonicalSnapshotName('snapshot-20261327T115959Z'), false);

  assert.equal(observer.SCHEMA_VERSION, 1);
  assert.equal(observer.MAX_DIRECTORY_ENTRIES, 4096);
  assert.equal(observer.SNAPSHOT_NAME.test('snapshot-20260827T115959Z'), true);
  assert.equal(observer.SNAPSHOT_NAME.test('backup-20260827T115959Z'), false);

  const observation = observer.observeBackupDestination(ROOT, {
    nowMs: NOW,
    fsImpl: fakeFs([
      'notes',
      'snapshot-20260826T090000Z',
      'snapshot-20260827T115959Z'
    ])
  });
  assert.deepEqual(observation, {
    schemaVersion: 1,
    kind: 'backup-age-observation',
    reportMode: 'report-only',
    observedAt: '2026-08-27T12:00:00.000Z',
    lastBackupAt: '2026-08-27T11:59:59.000Z'
  });
  assert.equal(Object.isFrozen(observation), true);

  const unavailable = observer.unavailableObservation('2026-08-27T12:00:00.000Z');
  assert.deepEqual(unavailable, {
    schemaVersion: 1,
    kind: 'backup-age-observation',
    reportMode: 'report-only',
    observedAt: '2026-08-27T12:00:00.000Z',
    lastBackupAt: null
  });
  assert.equal(Object.isFrozen(unavailable), true);
  assert.equal(Object.isFrozen(observer), true);

  process.stdout.write('coordinator-backup-observer-firsttest2: behaviour checks passed\n');
}

try {
  run();
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}
