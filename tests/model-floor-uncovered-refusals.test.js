'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

// Load the real module, then put tripwires around every synchronous filesystem
// write and process-launch API.  These refusals are pre-dispatch decisions: a
// rejected selection or incomplete scan must not cause either side effect.
const modelFloor = require('../src/lib/model-floor');
const originals = new Map();
const sideEffects = [];

for (const [owner, names] of [
  [fs, ['appendFileSync', 'copyFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'writeFileSync']],
  [childProcess, ['execFileSync', 'execSync', 'spawn', 'spawnSync']]
]) {
  for (const name of names) {
    originals.set(`${owner === fs ? 'fs' : 'childProcess'}.${name}`, owner[name]);
    owner[name] = (...args) => {
      sideEffects.push({ name, args });
      throw new Error(`unexpected side effect through ${name}`);
    };
  }
}

try {
  const unknown = modelFloor.evaluateModel({
    backend: 'subscription',
    model: { unreadable: true },
    purpose: 'delegation'
  });
  assert.deepEqual(
    {
      allowed: unknown.allowed,
      model: unknown.model,
      backend: unknown.backend,
      purpose: unknown.purpose,
      code: unknown.code
    },
    {
      allowed: false,
      model: { unreadable: true },
      backend: 'subscription',
      purpose: 'delegation',
      code: 'MODEL_FLOOR_UNKNOWN'
    }
  );
  assert.match(unknown.reason, /Honest-unknown: an unreadable model selection is refused/);
  assert.throws(
    () => modelFloor.assertModelAllowed({ backend: 'subscription', model: 17 }),
    (error) => {
      assert.equal(error.code, 'MODEL_FLOOR_UNKNOWN');
      assert.equal(error.model, 17);
      assert.equal(error.backend, 'subscription');
      assert.match(error.message, /non-string model/);
      return true;
    }
  );
  assert.deepEqual(sideEffects, [], 'MODEL_FLOOR_UNKNOWN must not write or spawn');

  assert.throws(
    () => modelFloor.findModelArguments({ first: 'ordinary', nested: { model: 'gemini-2.5-flash' } }, { maxNodes: 2 }),
    (error) => {
      assert.equal(error.code, 'MODEL_ARGUMENT_SCAN_INCOMPLETE');
      assert.equal(error.maxNodes, 2);
      assert.match(error.message, /unscanned arguments may contain a below-floor model/);
      return true;
    }
  );
  assert.deepEqual(sideEffects, [], 'MODEL_ARGUMENT_SCAN_INCOMPLETE must not write or spawn');
} finally {
  for (const [qualifiedName, original] of originals) {
    const [ownerName, name] = qualifiedName.split('.');
    (ownerName === 'fs' ? fs : childProcess)[name] = original;
  }
}

console.log('Model-floor uncovered refusal tests passed (2 driven refusal codes; zero writes or spawns).');
