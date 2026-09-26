'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { selectGateBatch } = require('../src/lib/owner-ledger-gate-batch');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-ledger-gate-batch-refusal-'));
const originalWriteFileSync = fs.writeFileSync;
const originalSpawn = childProcess.spawn;
let writes = 0;
let spawns = 0;

fs.writeFileSync = (...args) => {
  writes += 1;
  return originalWriteFileSync(...args);
};
childProcess.spawn = (...args) => {
  spawns += 1;
  return originalSpawn(...args);
};

function expectRefusal(input, code) {
  const before = fs.readdirSync(scratch);
  assert.throws(
    () => selectGateBatch(input),
    error => error instanceof TypeError
      && error.message === `OWNER_LEDGER_GATE_BATCH_${code}`
  );
  assert.deepEqual(fs.readdirSync(scratch), before, `${code} must not write a file`);
  assert.equal(writes, 0, `${code} must not call writeFileSync`);
  assert.equal(spawns, 0, `${code} must not spawn a process`);
}

try {
  expectRefusal(null, 'REQUEST_NOT_PLAIN_OBJECT');

  const requestWithNonArrayEntries = { entries: {}, cursor: null, count: 1 };
  const snapshot = structuredClone(requestWithNonArrayEntries);
  expectRefusal(requestWithNonArrayEntries, 'ENTRIES_NOT_ARRAY');
  assert.deepEqual(requestWithNonArrayEntries, snapshot, 'refusal must not mutate its request');
} finally {
  fs.writeFileSync = originalWriteFileSync;
  childProcess.spawn = originalSpawn;
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('owner-ledger-gate-batch request/entries refusals: 2 checks passed');
