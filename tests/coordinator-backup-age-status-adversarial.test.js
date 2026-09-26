'use strict';

const assert = require('node:assert/strict');
const { projectBackupAgeStatus } = require('../src/lib/coordinator/backup-age-status');

const nowMs = Date.parse('2026-07-29T12:30:00.000Z');
function observation() {
  return {
    schemaVersion: 1,
    kind: 'backup-age-observation',
    reportMode: 'report-only',
    observedAt: '2026-07-29T12:00:00.000Z',
    lastBackupAt: '2026-07-29T11:00:00.000Z'
  };
}
function unavailable(value) {
  const result = projectBackupAgeStatus(value, { nowMs });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.grantsAuthority, false);
  assert.equal(result.backupExistence, 'not-asserted');
  assert.equal(Object.isFrozen(result), true);
}

for (const mutate of [
  value => { value[Symbol('hidden')] = true; },
  value => Object.defineProperty(value, 'hidden', { enumerable: false, value: true }),
  value => Object.defineProperty(value, 'observedAt', { enumerable: true, get() { throw new Error('must not invoke getter'); } }),
  value => { value.observedAt = '2026-07-29T12:00:00Z'; },
  value => { value.lastBackupAt = '2026-02-30T11:00:00.000Z'; },
  value => { value.lastBackupAt = '2026-07-29T12:00:00.001Z'; }
]) {
  const value = observation();
  mutate(value);
  unavailable(value);
}

const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('must fail closed'); } });
unavailable(hostile);

const fresh = projectBackupAgeStatus(observation(), { nowMs, maxAgeMs: 7_200_000 });
assert.equal(fresh.status, 'fresh');
assert.equal(fresh.grantsAuthority, false);
assert.equal(fresh.backupExistence, 'not-asserted');

process.stdout.write('Backup-age status adversarial tests passed.\n');
