'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backupAge = require('../src/lib/coordinator/backup-age-status.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'backup-age-observation',
    reportMode: 'report-only',
    observedAt: '2026-07-29T12:00:00.000Z',
    lastBackupAt: '2026-07-29T11:00:00.000Z',
    ...overrides
  };
}

function run() {
  process.stdout.write('coordinator-backup-age-status\n');

  check('projects a fresh, deep-frozen redacted status from an injected observation', () => {
    const result = backupAge.projectBackupAgeStatus(observation(), { nowMs: NOW });
    assert.deepEqual(result, {
      schemaVersion: 1,
      status: 'fresh',
      observedAt: '2026-07-29T12:00:00.000Z',
      reportedBackupAt: '2026-07-29T11:00:00.000Z',
      ageMs: 3_600_000,
      contentTrust: 'untrusted',
      grantsAuthority: false,
      backupExistence: 'not-asserted'
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.keys(result).every(key => backupAge.OUTPUT_KEYS.includes(key)), true);
  });

  check('marks an otherwise valid observation stale only after the configured age boundary', () => {
    const atBoundary = backupAge.projectBackupAgeStatus(observation({ lastBackupAt: '2026-07-28T12:00:00.000Z' }), { nowMs: NOW });
    const afterBoundary = backupAge.projectBackupAgeStatus(observation({ lastBackupAt: '2026-07-28T11:59:59.999Z' }), { nowMs: NOW });
    assert.equal(atBoundary.status, 'fresh');
    assert.equal(afterBoundary.status, 'stale');
  });

  check('keeps a report-only observation unavailable when it carries no backup timestamp', () => {
    const result = backupAge.projectBackupAgeStatus(observation({ lastBackupAt: null }), { nowMs: NOW });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.observedAt, '2026-07-29T12:00:00.000Z');
    assert.equal(result.reportedBackupAt, null);
    assert.equal(result.ageMs, null);
    assert.equal(result.backupExistence, 'not-asserted');
  });

  check('fails closed for future, reversed, malformed, and non-canonical timestamps', () => {
    for (const candidate of [
      observation({ observedAt: '2026-07-29T12:00:00.001Z' }),
      observation({ lastBackupAt: '2026-07-29T12:00:00.001Z' }),
      observation({ lastBackupAt: '2026-07-29T12:01:00.000Z' }),
      observation({ observedAt: '2026-07-29T12:00:00Z' }),
      observation({ lastBackupAt: 'not-a-date' })
    ]) {
      assert.equal(backupAge.projectBackupAgeStatus(candidate, { nowMs: NOW }).status, 'unavailable');
    }
  });

  check('refuses to report a definite age when timestamp subtraction is not a safe integer', () => {
    const result = backupAge.projectBackupAgeStatus(observation({
      observedAt: '+275760-09-13T00:00:00.000Z',
      lastBackupAt: '-271821-04-20T00:00:00.000Z'
    }), { nowMs: Number.MAX_SAFE_INTEGER });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.observedAt, '+275760-09-13T00:00:00.000Z');
    assert.equal(result.reportedBackupAt, null);
    assert.equal(result.ageMs, null);
  });

  check('refuses destination-like fields and schema drift instead of redacting them after the fact', () => {
    const withDestination = { ...observation(), destination: 'C:\\sensitive' };
    const withError = { ...observation(), error: 'raw provider detail' };
    const wrongMode = observation({ reportMode: 'execute' });
    for (const candidate of [withDestination, withError, wrongMode, { ...observation(), schemaVersion: 2 }]) {
      const result = backupAge.projectBackupAgeStatus(candidate, { nowMs: NOW });
      assert.equal(result.status, 'unavailable');
      assert.equal(Object.hasOwn(result, 'destination'), false);
      assert.equal(Object.hasOwn(result, 'error'), false);
    }
  });

  check('refuses accessor-shaped observations without evaluating attacker-controlled getters', () => {
    let read = 0;
    const candidate = observation();
    Object.defineProperty(candidate, 'lastBackupAt', {
      enumerable: true,
      get() { read += 1; return '2026-07-29T11:00:00.000Z'; }
    });
    const result = backupAge.projectBackupAgeStatus(candidate, { nowMs: NOW });
    assert.equal(result.status, 'unavailable');
    assert.equal(read, 0);
  });

  check('has no storage, process, scheduler, vault, or backup-execution primitive', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coordinator', 'backup-age-status.js'), 'utf8');
    for (const forbidden of [/require\(['\"]node:fs/, /readdir/, /statSync/, /writeFile/, /copyFile/, /rename/, /unlink/, /exec(?:File)?Sync/, /spawn(?:Sync)?/, /secrets\.ps1/, /schedule/i]) {
      assert.equal(forbidden.test(source), false, `projection source contains forbidden primitive ${forbidden}`);
    }
  });

  process.stdout.write(`\ncoordinator-backup-age-status: ${passed} checks passed\n`);
}

try {
  run();
} catch (error) {
  process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`);
  process.exitCode = 1;
}
