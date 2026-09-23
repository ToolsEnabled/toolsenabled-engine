'use strict';

// Verified service-restart tests.
//
// The specific bug being pinned: on 2026-07-28 tools\dashboard-task.ps1 logged
// "Health check OK: port 3889 is listening (PID 25836)" while 25836 had already
// died of EADDRINUSE and an orphan from 17:41:57 was answering. Two deploys
// shipped nothing. Every test below exists to make that failure mode impossible
// to report as success.
//
// Fully offline: the probe, schtasks, the non-elevated reap, the delegation
// client, and the kill switch are all injected. No process is started, stopped,
// or killed by this suite.

const assert = require('node:assert/strict');

// Restart ladder fixtures declare the service explicitly. A customer's empty
// registry must not silently grant this offline test a default dashboard port.
const registryPath = require.resolve('../../src/lib/service-registry');
const realRegistry = require(registryPath);
const fixtureRegistry = realRegistry.loadRegistry({ registry: {
  schemaVersion: 1,
  machines: { fixture: { address: '127.0.0.1' } },
  services: { dashboard: { resolution: 'loopback', port: 3889 } }
} });
require.cache[registryPath].exports = { ...realRegistry, loadRegistry: () => fixtureRegistry };
const control = require('../../src/lib/service-control');
const uac = require('../../src/lib/uac-delegation');

const results = [];
const ok = message => { results.push(message); console.log(`OK: ${message}`); };

const iso = ms => new Date(ms).toISOString();

function listener(overrides = {}) {
  return control.normalizeListener({
    pid: 100,
    localAddress: '127.0.0.1',
    processName: 'node',
    commandLine: 'node C:\\Users\\fixture-user\\Desktop\\AgentActivityVisualizer\\server\\index.js --port 3889',
    startTime: iso(Date.now() - 3_600_000),
    accessible: true,
    error: null,
    ...overrides
  });
}

/**
 * A scripted probe: each call returns the next scripted snapshot, repeating the
 * last one forever. This is how "the port frees on the third poll" is expressed.
 */
function scriptedProbe(sequence) {
  const calls = [];
  let index = 0;
  const probe = port => {
    const state = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    calls.push(port);
    if (state === 'throw') throw new control.ServiceControlError('SERVICE_PROBE_FAILED', 'probe exploded');
    return { port, listeners: state };
  };
  probe.calls = calls;
  return probe;
}

function recorder() {
  const calls = [];
  const fn = (...args) => { calls.push(args); return { ok: true, stdout: '' }; };
  fn.calls = calls;
  return fn;
}

const fastDeps = { pollIntervalMs: 10, releaseTimeoutMs: 60, listenTimeoutMs: 60 };

(async () => {
  // -------------------------------------------------------------------------
  // 1. Happy path: the port frees, the task starts, and a NEW pid that started
  //    after the restart began is serving it.
  // -------------------------------------------------------------------------
  {
    const fresh = listener({ pid: 200, startTime: iso(Date.now() + 500) });
    const probe = scriptedProbe([[listener({ pid: 100 })], [], [fresh]]);
    const schtasks = recorder();
    const report = await control.restartService('dashboard', {
      ...fastDeps, probe, schtasks,
      reapLocal: () => { throw new Error('no reap should be needed'); },
      delegationClient: { runOperation: () => { throw new Error('no elevation should be needed'); } }
    });
    assert.equal(report.ok, true, 'a clean restart verifies');
    assert.equal(report.after.pid, 200);
    assert.deepEqual(report.before.map(l => l.pid), [100]);
    assert.deepEqual(schtasks.calls.map(call => call[0][0]), ['/End', '/Run'], 'stop then start');
    assert.ok(report.rungs.find(rung => rung.rung === 'verify' && rung.ok));
    ok('a clean restart is verified against the NEW pid and its start time');
  }

  // -------------------------------------------------------------------------
  // 2. THE BUG: after the start, the port is served by the SAME pid that held
  //    it before. This must be a loud failure, never "healthy".
  // -------------------------------------------------------------------------
  {
    const stale = listener({ pid: 34064 });
    // The port appears free once (so the ladder proceeds) and then the same old
    // pid is what answers -- the exact shape of a false health check.
    const probe = scriptedProbe([[stale], [], [stale]]);
    const report = await control.restartService('dashboard', { ...fastDeps, probe, schtasks: recorder() });
    assert.equal(report.ok, false, 'a stale listener is NEVER success');
    assert.equal(report.failure.code, 'SERVICE_STALE_LISTENER');
    assert.match(report.failure.message, /34064/);
    assert.match(report.failure.message, /ALREADY serving it before this restart/);
    assert.ok(report.rungs.find(rung => rung.rung === 'verify' && !rung.ok));
    ok('a port still served by the pre-restart pid is reported as SERVICE_STALE_LISTENER, not success');
  }

  // -------------------------------------------------------------------------
  // 3. A different pid that predates the restart (pid reuse / a second orphan)
  //    is also refused: identity is pid AND start time, not pid alone.
  // -------------------------------------------------------------------------
  {
    const old = listener({ pid: 777, startTime: iso(Date.now() - 7_200_000) });
    const probe = scriptedProbe([[listener({ pid: 100 })], [], [old]]);
    const report = await control.restartService('dashboard', { ...fastDeps, probe, schtasks: recorder() });
    assert.equal(report.ok, false);
    assert.equal(report.failure.code, 'SERVICE_STALE_LISTENER');
    assert.match(report.failure.message, /BEFORE this restart began/);
    ok('a listener whose start time predates the restart is refused even though its pid is new');
  }

  // -------------------------------------------------------------------------
  // 4. An unreadable start time cannot prove identity, so it is not success.
  // -------------------------------------------------------------------------
  {
    const opaque = listener({ pid: 900, startTime: null, accessible: false, error: 'Access is denied' });
    const probe = scriptedProbe([[listener({ pid: 100 })], [], [opaque]]);
    const report = await control.restartService('dashboard', { ...fastDeps, probe, schtasks: recorder() });
    assert.equal(report.ok, false);
    assert.equal(report.failure.code, 'SERVICE_VERIFY_INCONCLUSIVE');
    assert.match(report.failure.message, /cannot be proven/);
    ok('an unprovable listener identity is reported as inconclusive, not success');
  }

  // -------------------------------------------------------------------------
  // 5. Port still held after the whole ladder: fail loudly with the diagnosis,
  //    and do NOT start the task on top of the orphan.
  // -------------------------------------------------------------------------
  {
    const orphan = listener({ pid: 34064, accessible: false, commandLine: null, error: 'Access is denied' });
    const probe = scriptedProbe([[orphan]]); // never releases
    const schtasks = recorder();
    const reapLocal = () => ({ ok: false, exitCode: 1, detail: 'Reap failed: exact node PID 34064 did not release port 3889.' });
    const elevated = [];
    const report = await control.restartService('dashboard', {
      ...fastDeps, probe, schtasks, reapLocal, allowElevation: true,
      killSwitch: { status: () => ({ active: false }) },
      delegationClient: { runOperation: async id => { elevated.push(id); return { ok: false, decision: 'accept', reason: 'allowed', outcome: { ok: false, steps: [] } }; } }
    });
    assert.equal(report.ok, false);
    assert.equal(report.failure.code, 'SERVICE_PORT_STILL_HELD');
    assert.match(report.failure.message, /STILL HELD/);
    assert.match(report.failure.message, /pid=34064/, 'the diagnosis names the holder');
    assert.match(report.failure.message, /openable=false/, 'the diagnosis states the holder is unreachable');
    assert.match(report.failure.message, /commandLine=unreadable/, 'the diagnosis states the identity gap');
    assert.match(report.failure.message, /NOTHING was reported as healthy/);
    assert.deepEqual(elevated, ['reap-dashboard-listener-3889'], 'the single allowlisted elevated reap was the last rung');
    assert.deepEqual(schtasks.calls.map(call => call[0][0]), ['/End'],
      'the task is NOT started while the port is still held -- that is what produced the false success');
    for (const rung of ['probe-before', 'stop-task', 'await-release', 'reap-local', 'reap-elevated']) {
      assert.ok(report.rungs.find(entry => entry.rung === rung), `the report accounts for rung ${rung}`);
    }
    ok('a port that cannot be reclaimed fails loudly with the full diagnosis and never starts on top of the orphan');
  }

  // -------------------------------------------------------------------------
  // 6. The kill switch blocks the elevated escalation.
  // -------------------------------------------------------------------------
  {
    const orphan = listener({ pid: 34064 });
    const elevated = [];
    const report = await control.restartService('dashboard', {
      ...fastDeps, allowElevation: true,
      probe: scriptedProbe([[orphan]]),
      schtasks: recorder(),
      reapLocal: () => ({ ok: false, detail: 'access denied' }),
      killSwitch: { status: () => ({ active: true }) },
      delegationClient: { runOperation: async id => { elevated.push(id); return { ok: true }; } }
    });
    assert.equal(report.ok, false);
    assert.equal(report.failure.code, 'SERVICE_KILLSWITCH');
    assert.deepEqual(elevated, [], 'the kill switch prevents the elevated call entirely');
    assert.ok(report.rungs.find(rung => rung.rung === 'reap-elevated' && /KILLSWITCH/.test(rung.detail || '')));
    ok('an active kill switch blocks the elevated reap and the restart fails loudly');
  }

  // -------------------------------------------------------------------------
  // 8. --no-elevate never touches the delegation client.
  // -------------------------------------------------------------------------
  {
    const elevated = [];
    const report = await control.restartService('dashboard', {
      ...fastDeps, allowElevation: false,
      probe: scriptedProbe([[listener({ pid: 34064 })]]),
      schtasks: recorder(),
      reapLocal: () => ({ ok: false, detail: 'access denied' }),
      delegationClient: { runOperation: async id => { elevated.push(id); return { ok: true }; } }
    });
    assert.equal(report.ok, false);
    assert.deepEqual(elevated, []);
    assert.ok(report.rungs.find(rung => rung.rung === 'reap-elevated' && /elevation was disabled/.test(rung.detail || '')));
    ok('elevation can be disabled and is then never attempted');
  }

  // -------------------------------------------------------------------------
  // 8b. THE ABSENCE CASE. A caller that says NOTHING about elevation must not
  //     be granted it. Tested before the presence case on purpose: every
  //     historical break of this shape was a caller that omitted the field, not
  //     one that set it wrong.
  //
  //     Written against the same scenario as case 8 so the ONLY difference is
  //     that `allowElevation` is absent rather than false. A behavioural
  //     assertion, not a source-text one: it asserts the delegation client was
  //     never reached, which is what a privilege escalation actually is.
  // -------------------------------------------------------------------------
  {
    const elevated = [];
    const report = await control.restartService('dashboard', {
      ...fastDeps,
      probe: scriptedProbe([[listener({ pid: 34064 })]]),
      schtasks: recorder(),
      reapLocal: () => ({ ok: false, detail: 'access denied' }),
      killSwitch: { status: () => ({ active: false }) },
      delegationClient: { runOperation: async id => { elevated.push(id); return { ok: true }; } }
    });
    assert.equal(report.ok, false);
    assert.deepEqual(elevated, [],
      'a caller that never stated a ceiling reached the elevated delegation client: absence was read as consent');
    const rung = report.rungs.find(entry => entry.rung === 'reap-elevated');
    assert.ok(rung && rung.ok === false, 'the elevated rung must be recorded as not taken');
    assert.match(rung.detail || '', /did not state that elevation was allowed/,
      'the report must say elevation was WITHHELD FOR WANT OF A STATEMENT, not that the caller disabled it');
    ok('elevation omitted by the caller is withheld, and the report says so in those words');
  }

  // -------------------------------------------------------------------------
  // 8c. And the same silence must not be readable through a near-miss key. A
  //     future caller that writes `allowElevate` or `elevation: true` has still
  //     said nothing this function understands.
  // -------------------------------------------------------------------------
  {
    const elevated = [];
    const report = await control.restartService('dashboard', {
      ...fastDeps, allowElevate: true, elevation: true, allowElevation: 'true',
      probe: scriptedProbe([[listener({ pid: 34064 })]]),
      schtasks: recorder(),
      reapLocal: () => ({ ok: false, detail: 'access denied' }),
      killSwitch: { status: () => ({ active: false }) },
      delegationClient: { runOperation: async id => { elevated.push(id); return { ok: true }; } }
    });
    assert.equal(report.ok, false);
    assert.deepEqual(elevated, [],
      'a misspelled or string-typed elevation flag was accepted as permission to escalate');
    ok('only the literal boolean true permits the elevated rung');
  }

  // -------------------------------------------------------------------------
  // 9. An elevated call whose outcome is UNKNOWN never becomes a restart.
  // -------------------------------------------------------------------------
  {
    const timeout = Object.assign(new Error('no answer'), { code: 'UAC_CLIENT_TIMEOUT', outcomeUnknown: true });
    const schtasks = recorder();
    const report = await control.restartService('dashboard', {
      ...fastDeps, allowElevation: true,
      probe: scriptedProbe([[listener({ pid: 34064 })]]),
      schtasks,
      reapLocal: () => ({ ok: false, detail: 'access denied' }),
      killSwitch: { status: () => ({ active: false }) },
      delegationClient: { runOperation: async () => { throw timeout; } }
    });
    assert.equal(report.ok, false);
    assert.equal(report.failure.code, 'SERVICE_ELEVATED_OUTCOME_UNKNOWN');
    assert.deepEqual(schtasks.calls.map(call => call[0][0]), ['/End'], 'nothing is started on top of an unknown state');
    ok('an unknown elevated outcome stops the ladder instead of guessing');
  }

  // -------------------------------------------------------------------------
  // 10. A probe failure is a failure, not an assumption that the port is free.
  // -------------------------------------------------------------------------
  {
    const report = await control.restartService('dashboard', { ...fastDeps, probe: scriptedProbe(['throw']), schtasks: recorder() });
    assert.equal(report.ok, false);
    assert.equal(report.failure.code, 'SERVICE_PROBE_FAILED');
    ok('a failed observation is reported as a failure rather than assumed to be a free port');
  }

  // -------------------------------------------------------------------------
  // 11. Ambiguity (two listeners) cannot prove ownership either.
  // -------------------------------------------------------------------------
  {
    const a = listener({ pid: 201, startTime: iso(Date.now() + 100) });
    const b = listener({ pid: 202, startTime: iso(Date.now() + 100) });
    const report = await control.restartService('dashboard', {
      ...fastDeps, probe: scriptedProbe([[listener({ pid: 100 })], [], [a, b]]), schtasks: recorder()
    });
    assert.equal(report.ok, false);
    assert.equal(report.failure.code, 'SERVICE_AMBIGUOUS_LISTENER');
    ok('two listeners after a restart is ambiguous and therefore not success');
  }

  // -------------------------------------------------------------------------
  // 12. A fresh installation grants no elevated service operation. The
  //     service table may name the installation-specific ids it would request,
  //     but the neutral shipped authority set must not grant them by default.
  // -------------------------------------------------------------------------
  {
    const allowlist = uac.loadAllowlist({ ownerPrincipal: 'TESTDOMAIN\\owner' });
    const referenced = Object.values(control.SERVICES).map(service => service.reapOperation).filter(Boolean);
    assert.deepEqual(referenced, ['reap-dashboard-listener-3889']);
    assert.deepEqual([...allowlist.operations.keys()], [], 'the shipped allowlist is neutral and empty');
    for (const id of referenced) assert.ok(!allowlist.operations.has(id), `${id} must require installation-specific configuration`);
    ok('the neutral shipped allowlist grants no elevated service operation');
  }

  // -------------------------------------------------------------------------
  // 13. An unknown service id is refused outright.
  // -------------------------------------------------------------------------
  {
    await assert.rejects(() => control.restartService('anything-else', fastDeps),
      error => error && error.code === 'SERVICE_UNKNOWN_ID');
    ok('only the known services can be restarted');
  }

  console.log(`Service control tests passed (${results.length} checks).`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  require.cache[registryPath].exports = realRegistry;
});
