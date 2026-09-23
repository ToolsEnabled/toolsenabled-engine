'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const { step } = require('../src/lib/setup/plan');

// Refusing malformed plan data must remain a validation-only operation. Patch the
// process-wide effect primitives so an accidental implementation change cannot
// write or launch something before returning the refusal.
const effects = [];
const originals = {
  writeFileSync: fs.writeFileSync,
  appendFileSync: fs.appendFileSync,
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
  exec: childProcess.exec,
  execFile: childProcess.execFile,
  fork: childProcess.fork
};

for (const name of ['writeFileSync', 'appendFileSync']) {
  fs[name] = (...args) => {
    effects.push({ kind: 'write', name, args });
    throw new Error(`unexpected ${name}`);
  };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execFile', 'fork']) {
  childProcess[name] = (...args) => {
    effects.push({ kind: 'spawn', name, args });
    throw new Error(`unexpected ${name}`);
  };
}

try {
  let returned = Symbol('step did not return');
  assert.throws(
    () => {
      returned = step({
        id: '   ',
        phase: 'configure',
        name: 'Malformed step',
        provenance: 'caller-supplied test input',
        writes: ['/should/not/be/written']
      });
    },
    error => {
      assert.equal(error.code, 'SETUP_PLAN_STEP_INVALID');
      assert.equal(error.message, 'Every step needs an identifier.');
      assert.equal(error.details.step.id, '   ');
      assert.deepEqual(error.details.step.writes, ['/should/not/be/written']);
      return true;
    }
  );
  assert.equal(typeof returned, 'symbol', 'a refused step does not return a plan step');
  assert.deepEqual(effects, [], 'refusal performs no filesystem writes or process launches');
} finally {
  Object.assign(fs, {
    writeFileSync: originals.writeFileSync,
    appendFileSync: originals.appendFileSync
  });
  Object.assign(childProcess, {
    spawn: originals.spawn,
    spawnSync: originals.spawnSync,
    exec: originals.exec,
    execFile: originals.execFile,
    fork: originals.fork
  });
}

console.log('setup plan invalid-step refusal: ok');
