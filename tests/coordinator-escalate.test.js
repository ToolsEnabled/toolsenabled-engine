'use strict';

// Contract tests for tools/coordinator-escalate.js. The CLI is driven as a
// function so every input and dependency is explicit: no Telegram traffic,
// real coordinator state, or wall clock can leak into these cases.

require('./lib/isolated-environment').activate('coordinator-escalate');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../tools/coordinator-escalate.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-escalate-'));
const T0 = Date.UTC(2027, 0, 1, 12);
const sendArgs = ['--send', '--id', 'fleet-supervisor', '--state', 'DOWN', '--reason', 'pid missing'];
let caseNumber = 0;

function dependencies(overrides = {}) {
  caseNumber += 1;
  return {
    stateFile: path.join(root, `case-${caseNumber}.json`),
    inboxOverrides: { inboxFile: path.join(root, `inbox-${caseNumber}.json`) },
    killSwitch: () => ({ active: false }),
    now: () => T0,
    sendToOwner: async () => ({ messageId: 'fixture-message-42' }),
    acknowledgeWithoutReply: () => {},
    ...overrides
  };
}

(async () => {
  // Exit 0 includes help, successful delivery, and every intentional refusal.
  assert.equal((await cli.run([])).code, 0);

  const delivered = await cli.run(sendArgs, dependencies());
  assert.equal(delivered.code, 0);
  assert.match(delivered.stdout, /^DELIVERED  fleet-supervisor:DOWN/m);

  const killedCalls = [];
  const killed = await cli.run(sendArgs, dependencies({
    killSwitch: () => ({ active: true }),
    sendToOwner: async value => { killedCalls.push(value); return { messageId: 'must-not-send' }; }
  }));
  assert.equal(killed.code, 0);
  assert.match(killed.stdout, /^REFUSED_KILLSWITCH  fleet-supervisor:DOWN/m);
  assert.equal(killedCalls.length, 0, 'the kill-switch refusal must not touch the channel');

  const duplicateDeps = dependencies();
  await cli.run(sendArgs, duplicateDeps);
  const duplicate = await cli.run(sendArgs, { ...duplicateDeps, now: () => T0 + 1 });
  assert.equal(duplicate.code, 0);
  assert.match(duplicate.stdout, /^SUPPRESS_DUPLICATE  fleet-supervisor:DOWN/m);

  const limitedDeps = dependencies();
  await cli.run(sendArgs, limitedDeps);
  const limited = await cli.run([
    '--send', '--id', 'health-observer', '--state', 'DOWN', '--reason', 'heartbeat missing'
  ], { ...limitedDeps, now: () => T0 + 1 });
  assert.equal(limited.code, 0);
  assert.match(limited.stdout, /^SUPPRESS_RATE_LIMIT  health-observer:DOWN/m);

  const hour = new Date(T0).getHours();
  const quiet = await cli.run(sendArgs, dependencies({
    policyOptions: { quietHours: { startHour: hour, endHour: (hour + 1) % 24 } }
  }));
  assert.equal(quiet.code, 0);
  assert.match(quiet.stdout, /^SUPPRESS_QUIET_HOURS  fleet-supervisor:DOWN/m);

  // Exit 1 names every input/state refusal rather than letting it throw.
  const unknown = await cli.run(['--wat']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /^unknown invocation/);

  const incomplete = await cli.run(['--send', '--id', 'fleet-supervisor']);
  assert.equal(incomplete.code, 1);
  assert.match(incomplete.stderr, /--send needs --id, --state and --reason/);

  const invalid = await cli.run([
    '--send', '--id', 'not an id', '--state', 'DOWN', '--reason', 'fixture'
  ], dependencies());
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /^ESCALATION_INVALID:/);

  const corruptDeps = dependencies();
  fs.writeFileSync(corruptDeps.stateFile, '{not json', 'utf8');
  const corrupt = await cli.run(sendArgs, corruptDeps);
  assert.equal(corrupt.code, 1);
  assert.match(corrupt.stderr, /^ESCALATION_STATE_CORRUPT:/);

  // Exit 2 is reserved for the loud refusal: SEND was selected but delivery
  // did not reach the owner channel.
  const failed = await cli.run(sendArgs, dependencies({
    sendToOwner: async () => {
      const error = new Error('bridge offline');
      error.code = 'TELEGRAM_BRIDGE_OFFLINE';
      throw error;
    }
  }));
  assert.equal(failed.code, 2);
  assert.match(failed.stdout, /^NOT DELIVERED  fleet-supervisor:DOWN  \(TELEGRAM_BRIDGE_OFFLINE\)/m);

  // JSON dry-run pins the refusal without writing state or calling the wire.
  const dryDeps = dependencies({ killSwitch: () => ({ active: true }) });
  const dry = await cli.run([...sendArgs, '--dry-run', '--json'], dryDeps);
  assert.equal(dry.code, 0);
  const preview = JSON.parse(dry.stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.killSwitchActive, true);
  assert.equal(preview.wouldSend, false);
  assert.equal(preview.decision, 'REFUSED_KILLSWITCH');
  assert.equal(fs.existsSync(dryDeps.stateFile), false);

  process.stdout.write('coordinator-escalate refusal and exit-code tests passed\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
