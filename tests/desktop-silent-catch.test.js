'use strict';

require('./lib/isolated-environment').activate('desktop-silent-catch');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const desktop = require('../src/lib/desktop');

// The sound did happen, but deletion could not be established: that is not
// the same observable answer as "the sound did not happen".
const unlinkSync = fs.unlinkSync;
let playedBeforeCleanupFailure = false;
try {
  fs.unlinkSync = () => { throw new Error('simulated cleanup denial'); };
  assert.throws(() => desktop.soundPlay({ sound: 'beep' }, {
    invoke: () => {
      playedBeforeCleanupFailure = true;
      return { stdout: 'OK' };
    }
  }), error => {
    assert.equal(error.code, 'DESKTOP_CLEANUP_FAILED');
    assert.equal(error.actionOutcome, 'may_have_completed');
    assert.match(error.message, /action may have completed/);
    return true;
  }, 'cleanup uncertainty must differ from a definite "this did not happen" answer');
} finally {
  fs.unlinkSync = unlinkSync;
}
assert.equal(playedBeforeCleanupFailure, true, 'the action happened before cleanup became uncertain');

console.log('Desktop silent-catch distinction test passed.');
