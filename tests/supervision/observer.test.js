'use strict';

const assert = require('node:assert/strict');

const health = require('../../src/lib/health-invariants.js');
const observer = require('../../src/lib/supervision/observer.js');

const previous = {
  subsystems: {
    api: { id: 'api', state: health.STATE.OK },
    queue: { id: 'queue', state: health.STATE.DOWN },
    telemetry: { id: 'telemetry', state: health.STATE.OK }
  }
};
const current = {
  subsystems: {
    api: { id: 'api', state: health.STATE.DEGRADED, reason: 'responses are slow' },
    queue: { id: 'queue', state: health.STATE.OK, reason: 'messages are flowing' },
    telemetry: { id: 'telemetry', state: health.STATE.UNKNOWN, reason: 'probe timed out' }
  }
};

const transitions = observer.diffTransitions(previous, current);

assert.deepEqual(transitions, [
  {
    id: 'api',
    from: health.STATE.OK,
    to: health.STATE.DEGRADED,
    reason: 'responses are slow',
    escalate: true,
    recovered: false
  },
  {
    id: 'queue',
    from: health.STATE.DOWN,
    to: health.STATE.OK,
    reason: 'messages are flowing',
    escalate: false,
    recovered: true
  },
  {
    id: 'telemetry',
    from: health.STATE.OK,
    to: health.STATE.UNKNOWN,
    reason: 'probe timed out',
    escalate: false,
    recovered: false
  }
]);

assert.equal(
  observer.describeTransition(transitions[0]),
  'HEALTH DEGRADED: api moved OK -> DEGRADED. responses are slow'
);
assert.equal(
  observer.describeTransition(transitions[1]),
  'HEALTH RECOVERED: queue is OK again (was DOWN).'
);
assert.equal(observer.transitionKey(transitions[0], 12_345_678), 'health.api.degraded.205');
assert.equal(observer.transitionKey(transitions[0], 12_399_999), 'health.api.degraded.206');

process.stdout.write('observer transition behaviour: ok\n');
