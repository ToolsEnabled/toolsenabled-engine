'use strict';

const assert = require('node:assert/strict');
const baseline = require('../fixtures/shipped-tool-inventory.json');

// The old count floor still included a removed owner-local provider. A fixed
// name inventory protects every retained tool, including losses hidden by an
// equal number of unrelated additions. New public tools update this reviewed
// fixture; a test run must never derive its expectation from the registry.
function assertShippedToolInventory(names) {
  assert.equal(baseline.schemaVersion, 1, 'the shipped inventory fixture must have a known schema');
  assert.ok(Number.isSafeInteger(baseline.toolCount) && baseline.toolCount > 0);
  assert.equal(baseline.tools.length, baseline.toolCount, 'the fixed inventory must retain its declared population');
  assert.equal(new Set(baseline.tools).size, baseline.toolCount, 'the fixed inventory cannot duplicate tool names');
  assert.deepEqual(baseline.tools, [...baseline.tools].sort(), 'the fixed inventory must remain sorted for review');
  assert.ok(Array.isArray(names) && names.every(name => typeof name === 'string'));
  assert.deepEqual([...names].sort(), baseline.tools, 'the shipped tool names differ from the reviewed retained inventory');
}

module.exports = { assertShippedToolInventory };
