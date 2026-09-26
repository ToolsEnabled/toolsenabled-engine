'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const meter = require('../src/lib/controller-metering');

const hash = character => character.repeat(64);
const roster = meter.accountRosterOf([]);
const record = {
  schemaVersion: 2,
  meterId: `mtr_${'V'.repeat(16)}`,
  auditSequence: 1,
  auditEventHash: hash('a'),
  taskRef: 'task.version-refusal',
  phaseRef: 'phase.validation',
  configurationHash: hash('b'),
  provider: 'local',
  accountAlias: 'unattributed',
  lane: 'local',
  modelAlias: 'local-model',
  sourceType: 'unavailable',
  tokenizerVersion: null,
  unavailableReason: 'not-applicable',
  requestClass: 'verification',
  window: {
    startedAt: '2026-08-27T00:00:00.000Z',
    endedAt: '2026-08-27T00:00:01.000Z',
    freshness: 'unavailable',
    completeness: 'unavailable'
  },
  units: {
    reportedTokens: null,
    deterministicTokens: null,
    billableUnits: null,
    costMicros: null
  },
  elapsedMs: 1000,
  queueMs: 0,
  idleMs: 0,
  retry: false,
  replay: false,
  cacheReuse: false,
  reviewVerdict: 'unavailable',
  terminalStatus: 'unknown',
  wasteReason: 'none'
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-meter-version-refusal-'));
const before = fs.readdirSync(sandbox);
let writes = 0;
let spawns = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const originalSpawnSync = childProcess.spawnSync;
fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
fs.appendFileSync = (...args) => { writes += 1; return originalAppendFileSync(...args); };
childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };

try {
  for (const invoke of [
    () => meter.normalizeRecord(record, { accountRoster: roster }),
    () => meter.aggregate([record], { accountRoster: roster })
  ]) {
    assert.throws(invoke, error =>
      error instanceof meter.MeterError
      && error.code === 'METER_VERSION_UNSUPPORTED'
      && error.message === 'MeterRecord schema version is unsupported.',
    'a complete future-version record must be refused with the version-specific error');
  }
  assert.equal(writes, 0, 'a version refusal must not write through filesystem APIs');
  assert.equal(spawns, 0, 'a version refusal must not spawn a process');
  assert.deepEqual(fs.readdirSync(sandbox), before, 'a version refusal must leave its output sandbox unchanged');
} finally {
  fs.writeFileSync = originalWriteFileSync;
  fs.appendFileSync = originalAppendFileSync;
  childProcess.spawnSync = originalSpawnSync;
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('Controller metering unsupported-version refusal tests passed.');
