'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const isolated = require('./lib/isolated-environment').activate('service-control-declarations');

const registryPath = require.resolve('../src/lib/service-registry');
const subjectPath = require.resolve('../src/lib/service-control');
const realRegistry = require(registryPath);
const fixtureRegistryPath = path.join(isolated.root, 'service-registry.json');
const declaredDashboard = port => ({ dashboard: { resolution: 'loopback', port } });
function writeRegistry(services) {
  fs.writeFileSync(fixtureRegistryPath, JSON.stringify({
    schemaVersion: 1,
    machines: { fixture: { address: '127.0.0.1' } },
    services
  }));
}
writeRegistry({});

// Exercise the customer-installation shape without changing the repository's
// registry. Only the file location is redirected; parsing, validation and cache
// behavior remain the real resolver, including changes between operations.
require.cache[registryPath].exports = {
  ...realRegistry,
  loadRegistry: options => realRegistry.loadRegistry({ ...options, registryPath: fixtureRegistryPath })
};
delete require.cache[subjectPath];
const control = require(subjectPath);

function scheduler(resultForRun = { ok: true }) {
  const calls = [];
  return {
    calls,
    invoke(args) {
      calls.push(args.slice());
      return args[0] === '/Run' ? resultForRun : { ok: true };
    }
  };
}

async function main() {
  let actualSpawns = 0;
  const forbidSpawn = () => { actualSpawns += 1; throw new Error('unexpected child-process spawn'); };

  assert.throws(
    () => control.SERVICES.dashboard.port,
    error => error && error.code === 'SERVICE_DASHBOARD_UNDECLARED' && /declares no dashboard service/.test(error.message)
  );
  assert.equal(actualSpawns, 0, 'an undeclared dashboard must refuse before spawning');

  const forbiddenEffects = {
    probe: forbidSpawn, schtasks: forbidSpawn, reapLocal: forbidSpawn,
    execFileSync: forbidSpawn,
    delegationClient: { runOperation: forbidSpawn }
  };
  const undeclaredReport = await control.restartService('dashboard', forbiddenEffects);
  assert.equal(undeclaredReport.ok, false);
  assert.equal(undeclaredReport.failure.code, 'SERVICE_DASHBOARD_UNDECLARED');
  assert.equal(undeclaredReport.port, null, 'a failed declaration must not invent a port for its report');
  assert.equal(Object.isFrozen(undeclaredReport), true);
  assert.deepEqual(undeclaredReport.rungs.map(rung => rung.rung), ['resolve-service']);
  assert.equal(actualSpawns, 0, 'resolution failure must not probe, schedule, reap or delegate');

  for (const port of [null, 0, -1, 65536, 1.5, '3889']) {
    writeRegistry(declaredDashboard(port));
    const invalid = await control.restartService('dashboard', forbiddenEffects);
    assert.equal(invalid.failure.code, 'SERVICE_REGISTRY_INVALID', `invalid declared port ${JSON.stringify(port)} must refuse`);
    assert.equal(invalid.port, null);
    assert.equal(actualSpawns, 0);
  }
  fs.writeFileSync(fixtureRegistryPath, '{');
  const damaged = await control.restartService('dashboard', forbiddenEffects);
  assert.equal(damaged.failure.code, 'SERVICE_REGISTRY_INVALID');
  assert.equal(actualSpawns, 0, 'malformed on-disk data must not fall back to a cached declaration');

  writeRegistry(declaredDashboard(3889));
  assert.equal(control.SERVICES.dashboard.port, 3889);
  writeRegistry(declaredDashboard(4999));
  assert.equal(control.SERVICES.dashboard.port, 4999, 'a later operation must observe the changed declared port');
  fs.unlinkSync(fixtureRegistryPath);
  const unavailable = await control.restartService('dashboard', forbiddenEffects);
  assert.equal(unavailable.failure.code, 'SERVICE_REGISTRY_UNAVAILABLE', 'an unavailable file must not reuse the last valid declaration');
  assert.equal(unavailable.port, null);
  assert.equal(actualSpawns, 0);
  writeRegistry({});
  const revoked = await control.restartService('dashboard', forbiddenEffects);
  assert.equal(revoked.failure.code, 'SERVICE_DASHBOARD_UNDECLARED', 'a warm valid cache must not revive a removed declaration');
  assert.equal(actualSpawns, 0);
  writeRegistry(declaredDashboard(3889));

  assert.throws(
    () => control.defaultProbe(3888, { platform: 'darwin', execFileSync: forbidSpawn }),
    error => error && error.code === 'SERVICE_PROBE_PLATFORM_UNSUPPORTED' && /no process was started, stopped, or reaped/.test(error.message)
  );
  assert.equal(actualSpawns, 0, 'an unsupported probe platform must not spawn');

  const failedStart = scheduler({ ok: false, detail: 'scheduler rejected run' });
  const startReport = await control.restartService('dashboard', {
    probe: () => ({ port: 3889, listeners: [] }),
    schtasks: failedStart.invoke,
    execFileSync: forbidSpawn,
    releaseTimeoutMs: 0,
    listenTimeoutMs: 0
  });
  assert.equal(startReport.ok, false);
  assert.equal(startReport.failure.code, 'SERVICE_START_FAILED');
  assert.match(startReport.failure.message, /scheduler rejected run/);
  assert.deepEqual(failedStart.calls.map(call => call[0]), ['/End', '/Run']);
  assert.equal(actualSpawns, 0, 'the injected scheduler boundary must prevent a real spawn');

  const noListener = scheduler();
  const absentReport = await control.restartService('dashboard', {
    probe: () => ({ port: 3889, listeners: [] }),
    schtasks: noListener.invoke,
    execFileSync: forbidSpawn,
    releaseTimeoutMs: 0,
    listenTimeoutMs: 0
  });
  assert.equal(absentReport.ok, false);
  assert.equal(absentReport.failure.code, 'SERVICE_NOT_LISTENING');
  assert.equal(absentReport.after, null);
  assert.deepEqual(noListener.calls.map(call => call[0]), ['/End', '/Run']);
  assert.equal(actualSpawns, 0);

  const wrongProcess = scheduler();
  let probeCount = 0;
  const unexpected = {
    pid: 4242,
    localAddress: '127.0.0.1',
    processName: 'node',
    commandLine: 'node definitely-not-the-dashboard.js',
    startTime: new Date(10_000).toISOString(),
    startedAtMs: 10_000,
    accessible: true,
    error: null
  };
  const processReport = await control.restartService('dashboard', {
    probe: () => ({ port: 3889, listeners: probeCount++ < 2 ? [] : [unexpected] }),
    schtasks: wrongProcess.invoke,
    execFileSync: forbidSpawn,
    clock: () => 10_000,
    releaseTimeoutMs: 0,
    listenTimeoutMs: 0
  });
  assert.equal(processReport.ok, false);
  assert.equal(processReport.failure.code, 'SERVICE_UNEXPECTED_PROCESS');
  assert.equal(processReport.after, unexpected);
  assert.deepEqual(wrongProcess.calls.map(call => call[0]), ['/End', '/Run']);
  assert.equal(actualSpawns, 0);

  // Resolve exactly once before the ladder. A later registry edit cannot make
  // the report or subsequent probe silently describe a different operation.
  const snapshotScheduler = scheduler();
  const ports = [];
  const fresh = { ...unexpected, pid: 4243,
    commandLine: 'node /fixture/AgentActivityVisualizer/server/index.js' };
  const snapshotReport = await control.restartService('dashboard', {
    probe: port => {
      ports.push(port);
      if (ports.length === 1) writeRegistry(declaredDashboard(4999));
      return { port, listeners: ports.length < 3 ? [] : [fresh] };
    },
    schtasks: snapshotScheduler.invoke,
    execFileSync: forbidSpawn,
    clock: () => 10_000,
    releaseTimeoutMs: 0,
    listenTimeoutMs: 0
  });
  assert.equal(snapshotReport.ok, true, 'the real ladder must still verify a new sole expected listener');
  assert.equal(snapshotReport.port, 3889);
  assert.deepEqual(ports, [3889, 3889, 3889], 'every rung and the report must share the one validated port');
  assert.equal(control.SERVICES.dashboard.port, 4999, 'a new operation sees the newer declaration');
  assert.deepEqual(snapshotScheduler.calls.map(call => call[0]), ['/End', '/Run']);
  assert.equal(actualSpawns, 0);

  await assert.rejects(() => control.restartService('not-a-known-service', forbiddenEffects),
    error => error.code === 'SERVICE_UNKNOWN_ID');
  assert.equal(actualSpawns, 0, 'unknown IDs remain argument errors before effects');

  console.log('service-control driven refusal tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  require.cache[registryPath].exports = realRegistry;
  delete require.cache[subjectPath];
});
