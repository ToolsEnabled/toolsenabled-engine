'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const REFUSALS = [
  'ADAPTER_NOT_CONFIGURED',
  'ADAPTER_RESPONSE_INVALID',
  'AUDIT_LEDGER_INCOMPLETE',
  'AUDIT_LEDGER_INVALID',
  'AUDIT_LEDGER_UNAVAILABLE',
  'CHURN_LEDGER_INCOMPLETE',
  'LOCAL_USAGE_UNIT_UNAVAILABLE',
  'PROVIDER_ALLOWANCE_NOT_MACHINE_READABLE'
];

function main() {
  let effects = 0;
  const restorations = [];
  const forbid = (object, names) => {
    for (const name of names) {
      const original = object[name];
      object[name] = () => {
        effects += 1;
        throw new Error(`unexpected side effect: ${name}`);
      };
      restorations.push(() => { object[name] = original; });
    }
  };

  forbid(fs, ['appendFileSync', 'writeFileSync']);
  forbid(childProcess, ['exec', 'execFile', 'spawn', 'spawnSync']);

  try {
    // Load and drive the public module while effectful Node APIs are fenced.
    // Each reason must be accepted by validation and returned as a numberless,
    // immutable UNKNOWN record rather than throwing or inventing allowance.
    const usage = require('../../src/lib/usage/usage-contract');
    for (const code of REFUSALS) {
      assert.equal(usage.UNKNOWN_REASONS[code], code, `${code} must remain an exported refusal`);
      const record = usage.unknownUsageRecord({
        accountId: 'account-main',
        provider: 'codex',
        lane: 'usage-reader',
        reason: usage.UNKNOWN_REASONS[code],
        observedAt: '2026-08-27T12:00:00.000Z'
      });

      assert.deepEqual(record, {
        schemaVersion: 1,
        accountId: 'account-main',
        provider: 'codex',
        lane: 'usage-reader',
        used: null,
        remaining: null,
        unit: null,
        resetsAt: null,
        provenance: 'UNKNOWN',
        observedAt: '2026-08-27T12:00:00.000Z',
        reason: code,
        scope: 'UNKNOWN'
      }, `${code} must return an honest, numberless refusal`);
      assert(Object.isFrozen(record), `${code} refusal must be immutable`);
    }
    assert.equal(effects, 0, 'constructing refusals must neither write nor spawn');
  } finally {
    for (const restore of restorations.reverse()) restore();
  }

  console.log(`usage-contract driven refusals: ${REFUSALS.length} ok`);
}

main();
