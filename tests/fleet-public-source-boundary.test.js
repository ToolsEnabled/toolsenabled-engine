'use strict';
require('./lib/isolated-environment').activate('fleet-public-source-boundary');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = path.join(root, 'public-source/ALLOWLIST.txt');

test('every public file, including tests, excludes private ticket references and host names', () => {
  const names = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n');
  assert.deepEqual(names, [...new Set(names)].sort());
  assert.ok(names.some(name => name.startsWith('tests/')));
  assert.ok(names.some(name => name.startsWith('src/')));
  for (const name of names) {
    assert.doesNotMatch(name, /^(?:\.git|\.github|\.githooks|handtest)(?:\/|$)/);
    if (name === 'installer/openshell/fleet_legacy_inventory.json') continue;
    const body = fs.readFileSync(path.join(root, name), 'utf8');
    const privateRef = /\b[TRAP]\d{3,}(?:\.\d+)*\b|\bc[0-9]{1,2}\b|\b(?:Q3\d|R8\d|B(?:[1-9]|[1-2]\d)|O\d|G\d|H\d|T[5-9]|P\d\.\d|(?:AUDIT|CRED|AE)-F-?\d{1,2})\b/i;
    assert.equal(privateRef.test(body), false, name);
    assert.equal(privateRef.test('cred' + '-F6'), true, 'scan catches mixed-case short labels');
    assert.equal(privateRef.test('AE' + '-F-6'), true, 'scan catches both separator forms');
  }
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'config/settings-registry.json'), 'utf8'));
  assert.equal(/owner (?:request|task) [TRAP]\d+/i.test(JSON.stringify(registry)), false);
});
