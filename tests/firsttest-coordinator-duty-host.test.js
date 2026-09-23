'use strict';

const assert = require('node:assert/strict');

const dutyHost = require('../src/lib/coordinator/duty-host.js');
const dutyRegistry = require('../src/lib/coordinator/duty-registry.js');
const heartbeat = require('../src/lib/coordinator/heartbeat.js');

function mechanical(id, run) {
  return {
    id,
    kind: dutyRegistry.DUTY_KIND.MECHANICAL,
    intervalMs: 0,
    description: `test duty ${id}`,
    run
  };
}

async function main() {
  let nowMs = 10_000;
  const calls = [];
  const duties = [
    mechanical('broken', () => {
      calls.push('broken');
      const error = new Error('deliberate duty failure');
      error.code = 'TEST_FAILURE';
      throw error;
    }),
    mechanical('following', () => {
      calls.push('following');
      return { outcome: heartbeat.DUTY_OUTCOME.OK, reason: 'completed' };
    })
  ];
  const state = dutyHost.createState({
    duties,
    bootId: 'firsttest-duty-host',
    pid: 42,
    startedAtMs: nowMs
  });

  let result;
  for (let cycle = 0; cycle < dutyHost.MAX_CONSECUTIVE_FAILURES; cycle += 1) {
    result = await dutyHost.runCycle({
      state,
      duties,
      now: () => nowMs,
      killSwitchActive: false
    });
    nowMs += 1;
  }

  assert.deepEqual(
    calls,
    ['broken', 'following', 'broken', 'following', 'broken', 'following'],
    'a thrown duty must not prevent the following duty from running in any cycle'
  );
  assert.equal(result.heartbeat.duties.broken.outcome, heartbeat.DUTY_OUTCOME.FAILED);
  assert.equal(
    result.heartbeat.duties.broken.consecutiveFailures,
    dutyHost.MAX_CONSECUTIVE_FAILURES,
    'the heartbeat must retain consecutive thrown-duty failures'
  );
  assert.match(result.heartbeat.duties.broken.reason, /TEST_FAILURE: deliberate duty failure/);
  assert.equal(result.heartbeat.duties.following.outcome, heartbeat.DUTY_OUTCOME.OK);
  assert.equal(
    result.heartbeat.hostState,
    heartbeat.HOST_STATE.DEGRADED,
    'the host must become DEGRADED when a duty reaches its failure budget'
  );

  process.stdout.write('firsttest-coordinator-duty-host: thrown duties are isolated and surfaced\n');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
