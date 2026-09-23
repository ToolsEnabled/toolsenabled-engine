'use strict';

// Focused behavioural test for the exported message composer in
// src/lib/coordinator/escalation-sink.js. Run alone with:
//   node tests/coordinator-escalation-sink-compose-message.test.js

require('./lib/isolated-environment').activate('coordinator-escalation-sink-compose-message');

const assert = require('node:assert/strict');
const sink = require('../src/lib/coordinator/escalation-sink.js');

const atMs = Date.parse('2027-01-15T08:30:00.000Z');
const message = sink.composeMessage({
  subsystemId: 'fleet-supervisor',
  state: 'DOWN',
  reason: 'The scheduled process stopped.',
  detail: 'No heartbeat has arrived for ten minutes.',
  detectedBy: 'coordinator-duty-host'
}, atMs);

assert.equal(message, [
  'COORDINATOR ESCALATION: fleet-supervisor is DOWN.',
  'The scheduled process stopped.',
  'No heartbeat has arrived for ten minutes.',
  'Detected 2027-01-15T08:30:00.000Z by coordinator-duty-host.',
  'This is an automated notice about a detected condition, not a reply to a message.'
].join('\n'), 'the exported composer must retain the condition, evidence, attribution, time, and notice semantics');

const maximumLengthMessage = sink.composeMessage({
  subsystemId: 'x',
  state: 'DOWN',
  reason: 'r'.repeat(3900),
  detectedBy: 'test-observer'
}, atMs);

assert.equal(maximumLengthMessage.length, 4000, 'an oversized composed message must respect the channel ceiling');
assert.equal(maximumLengthMessage.endsWith('...'), true, 'truncation must be explicit rather than silent');

console.log('coordinator-escalation-sink composeMessage tests passed.');
