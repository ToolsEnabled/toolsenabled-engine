'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { describe, it } = require('node:test');
const savings = require('../src/lib/controller-savings');

const hash = character => character.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));

function validPair(overrides = {}) {
  return {
    schemaVersion: 1,
    pairId: `sav_${'P'.repeat(16)}`,
    taskClass: 'review',
    baselineMeterId: `mtr_${'B'.repeat(16)}`,
    candidateMeterId: `mtr_${'C'.repeat(16)}`,
    baselineRecordHash: hash('a'),
    candidateRecordHash: hash('b'),
    attribution: 'bounded-context',
    protocolHash: hash('c'),
    validationRef: 'validation.run-01',
    nonOverlapping: true,
    window: {
      startedAt: '2026-08-27T00:00:00.000Z',
      endedAt: '2026-08-27T00:01:00.000Z',
      freshness: 'fresh',
      completeness: 'complete'
    },
    ...overrides
  };
}

function assertRefusalWithoutEffects(invoke, expectedCode) {
  const writes = [];
  const spawns = [];
  const originals = new Map();
  for (const name of ['appendFileSync', 'createWriteStream', 'writeFileSync']) {
    originals.set(`${name}:fs`, fs[name]);
    fs[name] = (...args) => { writes.push([name, args]); };
  }
  for (const name of ['exec', 'execFile', 'fork', 'spawn', 'spawnSync']) {
    originals.set(`${name}:child`, childProcess[name]);
    childProcess[name] = (...args) => { spawns.push([name, args]); };
  }

  let error;
  try {
    assert.throws(invoke, candidate => {
      error = candidate;
      return candidate instanceof savings.SavingsError && candidate.code === expectedCode;
    });
  } finally {
    for (const name of ['appendFileSync', 'createWriteStream', 'writeFileSync']) fs[name] = originals.get(`${name}:fs`);
    for (const name of ['exec', 'execFile', 'fork', 'spawn', 'spawnSync']) childProcess[name] = originals.get(`${name}:child`);
  }

  assert.equal(error.code, expectedCode);
  assert.deepEqual(writes, [], 'a refused call must not write files');
  assert.deepEqual(spawns, [], 'a refused call must not spawn processes');
}

describe('controller savings refusals', () => {
  it('throws SAVINGS_INVALID for malformed pair input without effects', () => {
    const input = null;
    assertRefusalWithoutEffects(() => savings.normalizePair(input), 'SAVINGS_INVALID');
    assert.equal(input, null);
  });

  it('throws SAVINGS_VERSION_UNSUPPORTED for a future pair without effects', () => {
    const input = validPair({ schemaVersion: 2 });
    const before = clone(input);
    assertRefusalWithoutEffects(() => savings.normalizePair(input), 'SAVINGS_VERSION_UNSUPPORTED');
    assert.deepEqual(input, before, 'refusing a version must not mutate its input');
  });

  it('throws SAVINGS_DUPLICATE for repeated audit pairs without effects', () => {
    const pair = validPair();
    const events = [0, 1].map(index => ({
      action: savings.ACTION,
      target: `audit-target-${index}`,
      details: { schemaVersion: 1, pair: clone(pair) }
    }));
    const before = clone(events);
    assertRefusalWithoutEffects(() => savings.pairsFromAuditEvents(events), 'SAVINGS_DUPLICATE');
    assert.deepEqual(events, before, 'refusing duplicates must not mutate the audit events');
  });
});
