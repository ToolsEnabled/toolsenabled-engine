'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FleetSupervisor } = require('../src/lib/fleet-supervisor/supervisor.js');

const originalStatSync = fs.statSync;
const subject = { repoRoot: path.resolve('/repo') };
let checks = 0;
try {
  for (const causeCode of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    fs.statSync = () => { const error = new Error('machine could not look'); error.code = causeCode; throw error; };
    assert.throws(
      () => FleetSupervisor.prototype.existsInRepo.call(subject, 'src/input.js'),
      error => error.code === 'INPUT_EXISTENCE_UNAVAILABLE'
        && error.cause.code === causeCode
        && /NOT claiming the input is absent/.test(error.message),
      `${causeCode} has a could-not-tell outcome rather than false`
    );
    checks += 1;
  }

  // CONTROL: only a legitimate negative retains the old absent answer.
  fs.statSync = () => undefined;
  assert.equal(FleetSupervisor.prototype.existsInRepo.call(subject, 'src/missing.js'), false);
  checks += 1;

  // CONTROL: the pre-existing successful lazy-runner cache stays latched.
  const runner = () => {};
  const cached = { _runLane: runner, runLane: null };
  assert.equal(FleetSupervisor.prototype.laneRunner.call(cached), runner);
  assert.equal(FleetSupervisor.prototype.laneRunner.call(cached), runner);
  checks += 2;
} finally {
  fs.statSync = originalStatSync;
}

console.log(`fleet-supervisor input existence: ${checks} checks passed`);
