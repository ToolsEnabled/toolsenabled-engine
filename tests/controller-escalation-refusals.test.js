'use strict';

require('./lib/isolated-environment').activate('controller-escalation-refusals');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const controllerPath = require.resolve('../src/lib/controller-escalation');
const delegationPath = require.resolve('../src/lib/delegation-contracts');
const originalDelegation = require.cache[delegationPath];
const originalController = require.cache[controllerPath];
const originalSpawners = Object.fromEntries(['spawn', 'spawnSync', 'fork'].map(name => [name, childProcess[name]]));
let spawnCalls = 0;

function refusingFs() {
  let writeCalls = 0;
  return {
    module: {
      readFileSync() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
      mkdirSync() { writeCalls += 1; },
      openSync() { writeCalls += 1; },
      writeFileSync() { writeCalls += 1; },
      fsyncSync() { writeCalls += 1; },
      closeSync() { writeCalls += 1; },
      renameSync() { writeCalls += 1; },
      rmSync() { writeCalls += 1; }
    },
    writes: () => writeCalls
  };
}

function expectRefusal(operation, code, statusCode) {
  assert.throws(operation, error => {
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
}

try {
  for (const name of Object.keys(originalSpawners)) {
    childProcess[name] = () => { spawnCalls += 1; throw new Error(`unexpected ${name}`); };
  }

  const normal = require(controllerPath);
  const versionFs = refusingFs();
  const versionStore = new normal.ControllerEscalationStore({ stateFile: path.join('/unused', 'version.json'), fsModule: versionFs.module });
  expectRefusal(() => versionStore.request({
    packetVersion: 'controller-escalation-handoff-v999', packet: null,
    requestedDecision: 'resolve_evidence', auditFence: null
  }), 'CONTROLLER_ESCALATION_VERSION_UNSUPPORTED', 400);
  assert.equal(versionFs.writes(), 0, 'unsupported request versions must not write state');

  delete require.cache[controllerPath];
  require.cache[delegationPath] = {
    id: delegationPath, filename: delegationPath, loaded: true,
    exports: {
      REQUESTED_DECISIONS: ['resolve_evidence'],
      validateEscalationPacket() { throw new Error('validator dependency failed'); }
    }
  };
  const unavailable = require(controllerPath);
  const unavailableFs = refusingFs();
  const unavailableStore = new unavailable.ControllerEscalationStore({ stateFile: path.join('/unused', 'unavailable.json'), fsModule: unavailableFs.module });
  expectRefusal(() => unavailableStore.stage({ packet: {}, auditFence: {} }),
    'CONTROLLER_ESCALATION_VALIDATION_UNAVAILABLE', 503);
  assert.equal(unavailableFs.writes(), 0, 'validator failure must not write state');
  assert.equal(spawnCalls, 0, 'refusals must not spawn a process');
} finally {
  for (const [name, implementation] of Object.entries(originalSpawners)) childProcess[name] = implementation;
  delete require.cache[controllerPath];
  if (originalController) require.cache[controllerPath] = originalController;
  if (originalDelegation) require.cache[delegationPath] = originalDelegation;
  else delete require.cache[delegationPath];
}

process.stdout.write('Controller escalation refusal tests passed.\n');
