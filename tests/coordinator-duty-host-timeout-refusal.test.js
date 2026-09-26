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
  const writes = [];
  const spawns = [];
  const logs = [];
  const calls = [];
  const duties = [
    mechanical('timed-out', async ctx => {
      calls.push('timed-out');
      await new Promise(() => { /* deliberately never settles */ });
      ctx.write('must not be reached');
      ctx.spawn('must not be reached');
      return { outcome: heartbeat.DUTY_OUTCOME.OK, reason: 'must not be reached' };
    }),
    mechanical('following', () => {
      calls.push('following');
      return { outcome: heartbeat.DUTY_OUTCOME.OK, reason: 'following duty completed' };
    })
  ];
  const state = dutyHost.createState({
    duties,
    bootId: 'timeout-refusal-test',
    pid: 42,
    startedAtMs: 1_000
  });

  const result = await dutyHost.runCycle({
    state,
    duties,
    now: () => 1_000,
    killSwitchActive: false,
    dutyTimeoutMs: 10,
    log: entry => logs.push(entry),
    ctx: {
      write: value => writes.push(value),
      spawn: value => spawns.push(value)
    }
  });

  assert.deepEqual(calls, ['timed-out', 'following'],
    'the timeout refusal must let the cycle continue to the next duty');
  assert.deepEqual(result.ran, [
    { id: 'timed-out', outcome: heartbeat.DUTY_OUTCOME.TIMEOUT },
    { id: 'following', outcome: heartbeat.DUTY_OUTCOME.OK }
  ]);

  const refusal = result.heartbeat.duties['timed-out'];
  assert.equal(refusal.outcome, heartbeat.DUTY_OUTCOME.TIMEOUT,
    'the returned heartbeat must distinguish a timeout from an ordinary failure');
  assert.equal(refusal.consecutiveFailures, 1);
  assert.match(refusal.reason, /^DUTY_TIMEOUT: duty exceeded its 10ms budget$/,
    'the caller-visible refusal must include the exact code and budget');
  assert.deepEqual(refusal.detail, null);
  assert.deepEqual(logs.map(({ event, duty, code }) => ({ event, duty, code })), [
    { event: 'duty-failed', duty: 'timed-out', code: 'DUTY_TIMEOUT' }
  ], 'the diagnostic event must carry the same refusal code');
  assert.deepEqual(writes, [], 'a refused duty must not reach its injected writer');
  assert.deepEqual(spawns, [], 'a refused duty must not reach its injected spawner');
  assert.equal(result.heartbeat.duties.following.outcome, heartbeat.DUTY_OUTCOME.OK);

  process.stdout.write('coordinator-duty-host-timeout-refusal: DUTY_TIMEOUT driven\n');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
