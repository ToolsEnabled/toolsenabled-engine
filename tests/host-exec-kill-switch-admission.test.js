'use strict';

// The audit writer can yield while the person activates the kill switch.
// Exercise the actual shell launch with a harmless command and a scratch
// marker. Only audit admission is controlled; no spawn or policy guard is mocked.
require('./lib/isolated-environment').activate('host-exec-kill-switch-admission');

const assert = require('node:assert/strict');
const test = require('node:test');
const host = require('../src/lib/providers/host-control');
const killSwitch = require('../src/lib/kill-switch');

const command = process.platform === 'win32'
  ? "Write-Output 'governance-audit-control'"
  : "printf 'governance-audit-control\\n'";
const durable = Object.freeze({ ok: true, durable: true, anchored: true });

test('an admitted harmless command executes with an inactive kill switch', async () => {
  killSwitch.deactivate();
  const result = await host.exec({ command, timeoutMs: 5000 }, {
    requireRecordAsync: async () => durable,
    recordAsync: async () => durable
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), 'governance-audit-control');
});

test('a kill switch activated during audit admission prevents the real command from starting', async t => {
  killSwitch.deactivate();
  let releaseAdmission;
  const admission = new Promise(resolve => { releaseAdmission = resolve; });
  let intentSeen = false;
  const pending = host.exec({ command, timeoutMs: 5000 }, {
    requireRecordAsync: action => {
      assert.equal(action, 'host.exec.intent');
      intentSeen = true;
      return admission;
    },
    recordAsync: async () => durable
  });
  try {
    assert.equal(intentSeen, true, 'the call reached audit admission with the switch inactive');
    killSwitch.activate();
    assert.equal(killSwitch.status().active, true);
    releaseAdmission(durable);
    await assert.rejects(pending.then(result => {
      t.diagnostic(`command completed after activation: ${JSON.stringify({ ok: result.ok, stdout: result.stdout, killSwitchActive: killSwitch.status().active })}`);
      return result;
    }), error => /KILLSWITCH is active/.test(error.message));
  } finally {
    releaseAdmission(durable);
    await pending.catch(() => undefined);
    killSwitch.deactivate();
  }
});

test('a kill switch activated while the native wrapper prepares prevents root launch', async t => {
  killSwitch.deactivate();
  const launch = process.platform === 'win32'
    ? require('../src/lib/windows-job-control').spawnInJob
    : require('../src/lib/linux-process-control').spawnLinuxOwned;
  let child;
  const pending = host.exec({ command, timeoutMs: 5000 }, {
    requireRecordAsync: async () => durable,
    recordAsync: async () => durable,
    spawnInJobImpl(file, args, options, dependencies) {
      child = launch(file, args, options, dependencies);
      // The retained wrapper exists, but its async readiness handshake has
      // not run on this thread yet. No command root has been authorized.
      killSwitch.activate();
      return child;
    }
  });
  try {
    const result = await pending;
    t.diagnostic(`native admission result: ${JSON.stringify({ ok: result.ok, stdout: result.stdout, error: result.error })}`);
    assert.equal(result.ok, false, 'native wrapper readiness cannot retain entry-time permission');
    assert.equal(result.stdout, '', 'the harmless root command must not have run');
    const outcome = await child.jobOutcome;
    const closed = await child.jobClosed;
    assert.equal(outcome.type, 'not-started');
    assert.equal(outcome.activeProcesses, 0);
    if (process.platform === 'win32') {
      assert.equal(closed.failure?.code, 'WINDOWS_JOB_LAUNCH_REFUSED', 'Windows retains the original policy refusal in its closure receipt');
    } else assert.equal(closed.failure, null);
  } finally {
    await pending.catch(() => undefined);
    if (child) await child.jobClosed.catch(() => undefined);
    killSwitch.deactivate();
  }
});
