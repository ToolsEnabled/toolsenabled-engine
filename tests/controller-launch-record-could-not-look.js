'use strict';

const assert = require('node:assert/strict');
const launch = require('../src/lib/controller-launch-record');

const startMs = Date.parse('2026-08-27T00:00:00Z');
const endMs = startMs + 60_000;
const events = [
  { action: 'coordinator.run.claim', timestamp: new Date(startMs - 1).toISOString() },
  { action: 'coordinator.run.claim', timestamp: new Date(startMs + 1).toISOString() }
];
let reads = 0;
const busyThenReadableAudit = {
  tail() {
    reads += 1;
    if (reads === 1) throw Object.assign(new Error('machine busy'), { code: 'EBUSY' });
    return events;
  }
};

const unavailable = launch.computeUnattributedWindow(
  { startMs, endMs }, { audit: busyThenReadableAudit }
);
assert.equal(unavailable.available, false);
assert.equal(unavailable.unavailableCode, 'LAUNCH_UNATTRIBUTED_LOOKUP_UNAVAILABLE');
assert.match(unavailable.unavailableReason, /NOT claiming.*absent/);
assert.equal(unavailable.unattributedEstimate, null,
  'EBUSY is could-not-look, not a definite zero');

const retried = launch.computeUnattributedWindow(
  { startMs, endMs }, { audit: busyThenReadableAudit }
);
assert.equal(reads, 2, 'the transient failure is not cached or latched');
assert.equal(retried.available, true);
assert.equal(retried.unavailableCode, null);
assert.equal(retried.unattributedEstimate, 1,
  'CONTROL: a successful read still produces the definite measurement');

console.log('OK: could-not-look is explicit, not absence, and is not latched');
