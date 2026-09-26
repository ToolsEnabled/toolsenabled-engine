'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { buildLegacyDottedDisposition } = require('../../src/lib/request-version/legacy-dotted-disposition');
const { TEST_MIGRATION_POLICY, buildLegacyDottedLedgerFixture } = require('../fixtures/legacy-dotted-ledger');

let checks = 0;

function expectReadOnlyRefusal(requests, expectedCode, policy = TEST_MIGRATION_POLICY) {
  const before = JSON.stringify(requests);
  let writes = 0;
  let spawns = 0;
  const originalWrite = fs.writeFileSync;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  fs.writeFileSync = (...args) => { writes += 1; return originalWrite(...args); };
  childProcess.spawn = (...args) => { spawns += 1; return originalSpawn(...args); };
  childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };
  try {
    assert.throws(
      () => buildLegacyDottedDisposition(requests, policy),
      error => error && error.code === expectedCode
    );
  } finally {
    fs.writeFileSync = originalWrite;
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }
  assert.equal(JSON.stringify(requests), before, `${expectedCode} must not mutate its input`);
  assert.equal(writes, 0, `${expectedCode} must not write files`);
  assert.equal(spawns, 0, `${expectedCode} must not spawn processes`);
  checks += 1;
}

expectReadOnlyRefusal({ requests: [] }, 'LEGACY_DOTTED_INPUT_INVALID');

const duplicateIds = buildLegacyDottedLedgerFixture().requests;
duplicateIds.push(structuredClone(duplicateIds[0]));
expectReadOnlyRefusal(duplicateIds, 'LEGACY_DOTTED_ID_DUPLICATE');

const invalidGates = buildLegacyDottedLedgerFixture().requests;
invalidGates.find(entry => entry.id === TEST_MIGRATION_POLICY.continuationIds[0]).gates = {};
expectReadOnlyRefusal(invalidGates, 'LEGACY_DOTTED_GATES_INVALID');

const invalidVerbatim = buildLegacyDottedLedgerFixture().requests;
invalidVerbatim.find(entry => entry.id === TEST_MIGRATION_POLICY.continuationIds[0]).verbatim = '';
expectReadOnlyRefusal(invalidVerbatim, 'LEGACY_DOTTED_VERBATIM_INVALID');

expectReadOnlyRefusal(buildLegacyDottedLedgerFixture().requests, 'LEGACY_DOTTED_POLICY_INVALID', {
  ...TEST_MIGRATION_POLICY,
  duplicatePairs: [[TEST_MIGRATION_POLICY.duplicatePairs[0][0], TEST_MIGRATION_POLICY.continuationIds[0]]]
});

console.log(`request-version/legacy-dotted-refusals: ${checks} driven refusals passed`);
