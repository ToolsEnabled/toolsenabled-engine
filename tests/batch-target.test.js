'use strict';

const assert = require('node:assert/strict');

const { sealOf } = require('../src/lib/cloud-agent/batch-target');

// A batch declaration may be reconstructed from JSON, a form, or a planner.
// Property insertion order is not part of that declaration's meaning, so the
// admission seal must remain stable when both top-level and nested keys arrive
// in a different order. A changed value, however, must produce a different
// seal or the runner could not detect a post-admission edit.
const first = {
  schemaVersion: 'toolsenabled.cloud-batch.target/v1',
  batchId: 'wave-1',
  bounds: { launchesPerMinute: 60, accounts: 2 }
};
const reordered = {
  bounds: { accounts: 2, launchesPerMinute: 60 },
  batchId: 'wave-1',
  schemaVersion: 'toolsenabled.cloud-batch.target/v1'
};
const edited = {
  bounds: { accounts: 2, launchesPerMinute: 61 },
  batchId: 'wave-1',
  schemaVersion: 'toolsenabled.cloud-batch.target/v1'
};

assert.equal(
  sealOf(first),
  sealOf(reordered),
  'sealOf treats object property order as formatting rather than a declaration change'
);
assert.notEqual(
  sealOf(first),
  sealOf(edited),
  'sealOf detects a changed launch bound'
);

console.log('batch-target test passed: canonical seals ignore key order and detect changed values');
