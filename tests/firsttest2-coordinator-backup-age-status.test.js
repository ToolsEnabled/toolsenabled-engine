/*
 * Mutation check: changed `ageMs <= maxAgeMs` to `ageMs < maxAgeMs`
 * in the backup-age-status module.
 * The edit landed: yes (verified in the module before running this file).
 * This file went red: yes (exit 1 at the fresh maximum-age boundary).
 */
'use strict';

const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_AGE_MS,
  projectBackupAgeStatus
} = require('../src/lib/coordinator/backup-age-status.js');

const nowMs = Date.parse('2026-08-27T12:00:00.000Z');

function observation(lastBackupAt) {
  return {
    schemaVersion: 1,
    kind: 'backup-age-observation',
    reportMode: 'report-only',
    observedAt: '2026-08-27T12:00:00.000Z',
    lastBackupAt
  };
}

const atFreshBoundary = projectBackupAgeStatus(
  observation('2026-08-26T12:00:00.000Z'),
  { nowMs }
);
assert.deepEqual(atFreshBoundary, {
  schemaVersion: 1,
  status: 'fresh',
  observedAt: '2026-08-27T12:00:00.000Z',
  reportedBackupAt: '2026-08-26T12:00:00.000Z',
  ageMs: DEFAULT_MAX_AGE_MS,
  contentTrust: 'untrusted',
  grantsAuthority: false,
  backupExistence: 'not-asserted'
});

const oneMillisecondTooOld = projectBackupAgeStatus(
  observation('2026-08-26T11:59:59.999Z'),
  { nowMs }
);
assert.equal(oneMillisecondTooOld.status, 'stale');
assert.equal(oneMillisecondTooOld.ageMs, DEFAULT_MAX_AGE_MS + 1);

process.stdout.write('PASS backup age is fresh through the maximum-age boundary and stale after it\n');
