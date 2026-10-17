'use strict';
/* Nonconnecting registration checks trust only CLI versions whose exact
 * outputs were measured (register.inspection.qualified); any other version is
 * refused rather than guessed. */
require('./lib/isolated-environment').activate('agents-inspection-qualified');

const test = require('node:test');
const assert = require('node:assert/strict');
const { bundledRegistry, qualifiedVersion, validateDescriptor } = require('../src/lib/agents/registry');

test('every measured version is accepted by its exact output and nothing else is', () => {
  const registry = bundledRegistry();
  for (const id of ['claude', 'codex']) {
    const inspection = registry.get(id).register.inspection;
    assert.ok(inspection.qualified.length >= 2, `${id} keeps the earlier qualified version too`);
    for (const row of inspection.qualified) assert.equal(qualifiedVersion(inspection, row.versionOutput), row.version);
    assert.equal(qualifiedVersion(inspection, 'unmeasured 9.9.9\n'), null);
    assert.equal(qualifiedVersion(inspection, inspection.qualified[0].versionOutput.trim()), null, 'output must match exactly');
  }
});

test('a descriptor must give each qualified version with its exact output', () => {
  const base = JSON.parse(JSON.stringify(require('../config/agents/codex.json')));
  const bad = rows => { const value = JSON.parse(JSON.stringify(base)); value.register.inspection.qualified = rows; return value; };
  assert.throws(() => validateDescriptor(bad([])), /qualified versions/);
  assert.throws(() => validateDescriptor(bad([{ version: '1.0.0' }])), /qualified versions/);
  assert.throws(() => validateDescriptor(bad([{ version: '1.0.0', versionOutput: 'x', extra: true }])), /qualified versions/);
  assert.doesNotThrow(() => validateDescriptor(bad([{ version: '1.0.0', versionOutput: 'codex-cli 1.0.0\n' }])));
});
