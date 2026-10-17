'use strict';
require('./lib/isolated-environment').activate('openshell-upgrade-route');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('fresh-account gate proves archive-free beta 3 upgrade route', () => {
  const script = fs.readFileSync(path.join(__dirname, '../installer/openshell/test-upgrade-beta3.py'), 'utf8');
  assert.doesNotMatch(script, /'--previous-archive'|'--previous-sha256'/);
  assert.match(script, /target\['version'\] == gate\.CURRENT_VERSION/);
});
