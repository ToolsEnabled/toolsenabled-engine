'use strict';

// Driven coverage for the version refusal in owner-request-scope. This test
// deliberately invokes the public normalizer with a complete rule whose only
// invalid field is its future schema version.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');

let writes = 0;
let spawns = 0;
const originalWriteFile = fs.writeFile;
const originalWriteFileSync = fs.writeFileSync;
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;

fs.writeFile = (...args) => {
  writes += 1;
  return originalWriteFile(...args);
};
fs.writeFileSync = (...args) => {
  writes += 1;
  return originalWriteFileSync(...args);
};
childProcess.spawn = (...args) => {
  spawns += 1;
  return originalSpawn(...args);
};
childProcess.spawnSync = (...args) => {
  spawns += 1;
  return originalSpawnSync(...args);
};

const scope = require('../src/lib/owner-request-scope');

const futureVersionRule = {
  schemaVersion: scope.VERSION + 1,
  ruleId: 'rule_future_version',
  ruleKey: 'work.mode',
  scopeKind: 'global',
  threadId: null,
  sourceRequestId: 'R173',
  issuedAt: '2026-08-27T10:00:00.000Z',
  expiresAt: null,
  decisionSummary: 'Use the bounded controller work mode.',
  evidenceRefs: ['reports/OWNER-REQUEST-LEDGER.json#R173'],
  ownerVerbatim: 'Use this mode for all work.'
};

let returned = Symbol('not-returned');
let refusal;
try {
  returned = scope.normalizeScopeRule(futureVersionRule);
} catch (error) {
  refusal = error;
}

assert.equal(returned.description, 'not-returned', 'a refused rule must not produce a normalized value');
assert.ok(refusal instanceof scope.OwnerRequestScopeError, 'the module must throw its public refusal type');
assert.equal(refusal.code, 'OWNER_SCOPE_VERSION_UNSUPPORTED');
assert.equal(refusal.message, 'scope rule schemaVersion is unsupported.');
assert.equal(refusal.details, undefined, 'the version refusal must not invent field details');
assert.equal(writes, 0, 'version refusal must not write a file');
assert.equal(spawns, 0, 'version refusal must not spawn a process');

console.log('owner-request-scope-version-refusal: 7 checks passed');
