/* Mutation proof (performed 2026-08-27):
 * - Removed the SECRET_UNREADABLE return from blockingCode: this file failed.
 * - Removed the SECRET_METADATA_CONFLICT return from blockingCode: this file failed.
 * In both cases the edit landed, and doctor.js was restored to its original SHA-256:
 * 5d82ba90300af160e007a9ba2313d901de20bb68dfba4aababf8db463eb352a1.
 */
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { evaluateIntegration } = require('../../src/lib/secret-store/doctor');

const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
const originalWriteFile = fs.writeFile;
const originalWriteFileSync = fs.writeFileSync;
const effects = [];

childProcess.spawn = (...args) => effects.push(['spawn', args]);
childProcess.spawnSync = (...args) => effects.push(['spawnSync', args]);
fs.writeFile = (...args) => effects.push(['writeFile', args]);
fs.writeFileSync = (...args) => effects.push(['writeFileSync', args]);

function blockedSecret(name, state) {
  return {
    name,
    present: true,
    readable: false,
    managed: true,
    state,
    warnings: []
  };
}

function requiredIntegration(name, state) {
  const byName = new Map([[name, blockedSecret(name, state)]]);
  const result = evaluateIntegration({
    id: `required-${name}`,
    label: `Required ${name}`,
    criticality: 'required',
    alternatives: [[name]]
  }, byName);

  assert.equal(result.ready, false);
  assert.equal(result.state, 'will-fail');
  assert.deepEqual(result.error, {
    code: state === 'unreadable' ? 'SECRET_UNREADABLE' : 'SECRET_METADATA_CONFLICT',
    names: [name]
  });
  assert.deepEqual(result.requirements, [{
    alternative: 0,
    names: [name],
    ready: false,
    states: [{ name, state }]
  }]);
  assert.equal(byName.get(name).state, state, 'evaluation does not mutate its input');
}

try {
  requiredIntegration('opaque_api_key', 'unreadable');
  requiredIntegration('duplicated_api_key', 'conflict');
  assert.deepEqual(effects, [], 'refusing an integration neither writes nor spawns');
} finally {
  childProcess.spawn = originalSpawn;
  childProcess.spawnSync = originalSpawnSync;
  fs.writeFile = originalWriteFile;
  fs.writeFileSync = originalWriteFileSync;
}

console.log('PASS secret doctor returns driven unreadable and metadata-conflict refusals without effects');
