'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const {
  OwnerProvenanceError,
  normalizeProvenance
} = require('../src/lib/owner-request-provenance');

const calls = [];
const patched = [
  [fs, 'appendFile'],
  [fs, 'appendFileSync'],
  [fs, 'createWriteStream'],
  [fs, 'writeFile'],
  [fs, 'writeFileSync'],
  [childProcess, 'exec'],
  [childProcess, 'execFile'],
  [childProcess, 'fork'],
  [childProcess, 'spawn'],
  [childProcess, 'spawnSync']
];
const originals = patched.map(([owner, name]) => [owner, name, owner[name]]);

for (const [owner, name] of patched) {
  owner[name] = (...args) => {
    calls.push({ name, args });
    throw new Error(`unexpected side effect through ${name}`);
  };
}

try {
  assert.throws(
    () => normalizeProvenance(undefined),
    error => {
      assert.ok(error instanceof OwnerProvenanceError);
      assert.equal(error.code, 'OWNER_PROVENANCE_REQUIRED');
      assert.match(error.message, /A provenance record is required/);
      assert.match(error.message, /owner-stated, owner-ratified, agent-inferred, unclassified/);
      assert.equal(error.details, undefined);
      return true;
    }
  );
  assert.deepEqual(calls, [], 'refusal must not write files or spawn a process');
} finally {
  for (const [owner, name, original] of originals) owner[name] = original;
}

console.log('owner-request-provenance-required: 1 check passed');
