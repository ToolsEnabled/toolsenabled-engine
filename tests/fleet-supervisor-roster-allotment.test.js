'use strict';

// Behaviour tests for the owner-editable roster ceiling. These fixtures call
// the public API with real JSON files; they do not duplicate the validator or
// replace the model-floor dependency.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const allotment = require('../src/lib/fleet-supervisor/roster/allotment.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'allotment-behaviour-'));
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));

function writeFixture(name, value) {
  const fixturePath = path.join(tempRoot, name);
  fs.writeFileSync(fixturePath, typeof value === 'string' ? value : JSON.stringify(value));
  return fixturePath;
}

function validFixture(overrides = {}) {
  return {
    schemaVersion: allotment.SCHEMA_VERSION,
    enabled: true,
    allowed: [{
      role: 'builder',
      provider: 'gemini',
      backend: 'vertex',
      models: ['gemini-2.5-pro'],
      maxDispatchesPerDay: 3
    }],
    budgets: { maxTotalDispatchesPerDay: 8 },
    parameters: { minSamples: 7 },
    ...overrides
  };
}

process.stdout.write('fleet-supervisor-roster-allotment\n');

check('a missing file fails dormant instead of throwing or widening eligibility', () => {
  const missing = allotment.loadAllotment({
    allotmentPath: path.join(tempRoot, 'absent.json'),
    force: true
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.enabled, false);
  assert.equal(missing.source, 'missing');
  assert.deepEqual(missing.allowed, []);
  assert.match(missing.reason, /ABSENT/);
});

const loaded = allotment.loadAllotment({
  allotmentPath: writeFixture('valid.json', validFixture()),
  force: true
});

check('a valid file is normalized while preserving explicit ceilings and defaults', () => {
  assert.equal(loaded.ok, true);
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.allowed.length, 1, 'the entry assertion must not pass vacuously');
  assert.deepEqual(loaded.allowed[0], {
    role: 'builder', provider: 'gemini', backend: 'vertex',
    models: ['gemini-2.5-pro'], maxDispatchesPerDay: 3
  });
  assert.deepEqual(loaded.budgets, { maxTotalDispatchesPerDay: 8 });
  assert.deepEqual(loaded.parameters, { minSamples: 7, explorationEveryK: 5, suspendDays: 14 });
  assert.equal(loaded.sha256.length, 64);
});

check('isAllowed requires every pinned selection field to match', () => {
  const accepted = allotment.isAllowed(loaded, {
    role: 'builder', provider: 'gemini', backend: 'vertex', model: 'gemini-2.5-pro'
  });
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.entry, loaded.allowed[0]);

  for (const rejected of [
    { role: 'reviewer', provider: 'gemini', backend: 'vertex', model: 'gemini-2.5-pro' },
    { role: 'builder', provider: 'other', backend: 'vertex', model: 'gemini-2.5-pro' },
    { role: 'builder', provider: 'gemini', backend: 'subscription', model: 'gemini-2.5-pro' },
    { role: 'builder', provider: 'gemini', backend: 'vertex', model: 'gemini-3.1-pro-preview' }
  ]) {
    assert.equal(allotment.isAllowed(loaded, rejected).allowed, false, JSON.stringify(rejected));
  }
});

check('checkSelection reports allotment rejection separately from floor rejection', () => {
  const notAllotted = allotment.checkSelection({
    role: 'builder', provider: 'other', backend: 'vertex', model: 'gemini-2.5-pro'
  }, { allotment: loaded });
  assert.equal(notAllotted.eligible, false);
  assert.equal(notAllotted.stage, 'allotment');

  const offFloorAllotment = {
    enabled: true,
    allowed: [{ role: 'builder', provider: 'gemini', backend: 'vertex', models: ['gemini-2.5-flash'] }]
  };
  const offFloor = allotment.checkSelection({
    role: 'builder', provider: 'gemini', backend: 'vertex', model: 'gemini-2.5-flash'
  }, { allotment: offFloorAllotment });
  assert.equal(offFloor.eligible, false);
  assert.equal(offFloor.stage, 'floor');
  assert.match(offFloor.reason, /not servable|refused|floor|allowed/i);
});

check("an entry identifying the forbidden 'sol' tier refuses the whole file", () => {
  const refused = allotment.loadAllotment({
    allotmentPath: writeFixture('sol.json', validFixture({
      allowed: [{ role: 'reviewer', provider: 'codex-sol', models: null }]
    })),
    force: true
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.enabled, false);
  assert.deepEqual(refused.allowed, []);
  assert.match(refused.reason, /refuses the WHOLE file/);
});

check('snapshotOf exposes only the stable decision identity', () => {
  assert.deepEqual(allotment.snapshotOf(loaded), {
    path: 'config/agent-allotment.json', sha256: loaded.sha256, enabled: true
  });
});

process.stdout.write(`fleet-supervisor-roster-allotment: ${passed} checks passed\n`);
