'use strict';

const assert = require('node:assert/strict');
const luna = require('../../src/lib/fleet-supervisor/luna-executor.js');

// CONTROL: the established live result remains the same cheap single probe;
// broad "never answer" behavior would fail this assertion and reinstate work.
let probes = 0;
assert.equal(luna.processGroupContained(41, { kill() { probes += 1; } }), false);
assert.equal(probes, 1);

assert.equal(luna.processGroupContained(42, {
  kill() { const error = new Error('gone'); error.code = 'ESRCH'; throw error; }
}), true, 'ESRCH remains the definite absent result');

assert.throws(() => luna.processGroupContained(43, {
  kill() { const error = new Error('busy'); error.code = 'EBUSY'; throw error; }
}), error => error instanceof luna.LunaExecutorError
  && error.code === 'LUNA_PROCESS_CONTAINMENT_UNESTABLISHED'
  && /does NOT claim.*absent/.test(error.message),
'a busy probe must not claim that the process group is absent');

console.log('Luna process-group probe test passed.');
