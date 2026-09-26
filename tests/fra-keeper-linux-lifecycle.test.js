// EXECUTABLE CHANGE
// Audit report (testcanfail-tests-fra-keeper-linux-lifecycle-test-js):
// - Strengthened "Linux stop signals only an exact same-uid listener and proves
//   the port released" with an exact listener-probe count. Mutation: returned
//   `{ action: 'stopped', pid: identity.pid }` immediately after SIGTERM in
//   stopLinuxOwnedListener, bypassing its release-observation loop. Before the
//   strengthening the mutated product stayed green; afterward it went RED:
//   `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n2 !== 3`
// - NOT-FOUND (1): no assertion body is hidden in a loop/forEach over a
//   potentially empty collection.
// - NOT-FOUND (2): no exit-status/truthy-return assertion is the sole evidence
//   for a spawned subject; invocation details and/or exact outcomes are checked.
// - NOT-FOUND (3): no try/catch or optional chain swallows an asserted failure.
// - NOT-FOUND (4): injected collaborators are observed through subject outputs
//   and calls; no assertion merely asks the subject's own mock for the answer.
// - NOT-FOUND (5): the non-Linux branch asserts Windows explicitly, so the
//   platform precondition cannot silently turn this file into a no-op.
// - NOT-FOUND (6): no expected value is computed by the product code under test.
// - Preconditions: Linux was available, including readable procfs and local TCP
//   bind support. No audit precondition was unmet.
// - Restoration: tools/fra-keeper.js was restored byte-for-byte (SHA-256
//   4e5c85932b8e0b692f6c254692b49d479a073e38f103b091dacc819a4003c1ef).
//   The restored run was GREEN and ended `ok 10 - the real Linux procfs inventory
//   sees a live socket and its release\n1..10`.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const net = require('node:net');
const path = require('node:path');

// The shipped, unconfigured service registry intentionally has no machine-a
// or machine-b. fra-peer-heartbeat currently dereferences both at module load,
// which is a separate pre-existing customer-registry defect. Isolate this
// lifecycle test from that unrelated eager load; none of these checks invokes
// a heartbeat.
const originalLoad = Module._load;
Module._load = function loadWithHeartbeatIsolated(request, parent, isMain) {
  if (request === './fra-peer-heartbeat' && parent && /fra-keeper\.js$/.test(parent.filename)) {
    return {
      heartbeat: async () => ({ ok: true }),
      sanitizeHeartbeatTelemetry: () => ({ code: null, stage: null, attempt: null, elapsedMs: null, attemptsHistory: [] })
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let keeper;
try { keeper = require('../tools/fra-keeper'); }
finally { Module._load = originalLoad; }

function listener(pid = 42) {
  return { pid, accessible: true, startedAtMs: 123456 };
}

function linuxStat(startTicks = '777') {
  const fields = Array(22).fill('0');
  fields[0] = 'S';
  fields[19] = startTicks;
  return `42 (node) ${fields.join(' ')}`;
}

function identityFs({ uid = 1000, startTicks = '777' } = {}) {
  return {
    statSync() { return { uid }; },
    realpathSync(value) {
      const text = String(value);
      if (path.basename(text) === 'exe' || text === '/runtime/node') return '/runtime/node';
      if (text.endsWith('full-remote-access-listener-host.js')) return '/repo/tools/full-remote-access-listener-host.js';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    readFileSync(value) {
      const name = path.basename(String(value));
      if (name === 'cmdline') return Buffer.from('/runtime/node\0/repo/tools/full-remote-access-listener-host.js\0');
      if (name === 'stat') return linuxStat(startTicks);
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
  };
}

test('keeper lifecycle contracts and native platform coverage', async t => {
  const check = (name, body, options = {}) => t.test(name, options, body);
  await check('Linux port observation distinguishes a proven empty inventory from a listener', async () => {
    assert.equal(keeper.portListening(8790, true, {
      platform: 'linux', listenerProbe: () => ({ listeners: [] })
    }), false);
    assert.equal(keeper.portListening(8790, false, {
      platform: 'linux', listenerProbe: () => ({ listeners: [listener()] })
    }), true);
  });

  await check('Linux port observation preserves UNKNOWN instead of fabricating absence', async () => {
    assert.equal(keeper.portListening(8790, true, {
      platform: 'linux', listenerProbe: () => { throw new Error('procfs unreadable'); }
    }), true);
    assert.equal(keeper.portListening(8790, false, {
      platform: 'linux', listenerProbe: () => ({ invalid: true })
    }), false);
  });

  await check('Windows port observation keeps the existing PowerShell invocation and answers', async () => {
    const calls = [];
    const yes = keeper.portListening(8790, false, {
      platform: 'win32',
      spawnSyncApi: (file, args, options) => { calls.push({ file, args, options }); return { stdout: 'yes\r\n' }; }
    });
    assert.equal(yes, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'powershell.exe');
    assert.deepEqual(calls[0].args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy']);
  });

  await check('Linux start refuses through the Windows-security gate before spawning', async () => {
    let spawnCalls = 0;
    let verifyCalls = 0;
    const outcome = await keeper.startListener('192.0.2.10', { via: 'test' }, {
      platform: 'linux',
      spawnSyncApi: () => { spawnCalls += 1; throw new Error('must not spawn'); },
      rootAccessApi: {
        verifyFraRootAccess() {
          verifyCalls += 1;
          throw Object.assign(new Error('FRA root access verification requires Windows'), {
            code: 'FRA_ROOT_ACCESS_UNSUPPORTED'
          });
        }
      }
    });
    assert.equal(verifyCalls, 1);
    assert.equal(spawnCalls, 0);
    assert.deepEqual(outcome, { exitCode: 1, message: 'refused: FRA_ROOT_ACCESS_UNSUPPORTED' });
  });

  await check('Linux rendezvous refuses its DPAPI and named-pipe boundary before spawning', async () => {
    let spawnCalls = 0;
    const logs = [];
    const outcome = keeper.reconcileRendezvous({
      platform: 'linux',
      stateReader: () => ({ armed: true }),
      listenerProbe: () => ({ listeners: [] }),
      spawnSyncApi: () => { spawnCalls += 1; throw new Error('must not spawn'); },
      logFn: value => logs.push(value)
    });
    assert.equal(spawnCalls, 0);
    assert.deepEqual(outcome, { ok: false, code: 'FRA_RENDEZVOUS_SECURITY_UNSUPPORTED' });
    assert.equal(logs[0].code, 'FRA_RENDEZVOUS_SECURITY_UNSUPPORTED');
  });

  await check('Windows rendezvous keeps the existing scheduled-task start', async () => {
    const calls = [];
    const outcome = keeper.reconcileRendezvous({
      platform: 'win32',
      stateReader: () => ({ armed: true }),
      listenerProbe: undefined,
      spawnSyncApi(file, args) {
        calls.push({ file, args });
        if (args.some(value => String(value).includes('Get-NetTCPConnection'))) return { stdout: 'no\r\n', status: 0 };
        return { stdout: '', status: 0 };
      },
      logFn() {}
    });
    assert.equal(outcome, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].file, 'powershell.exe');
    assert.ok(calls[1].args.includes("Start-ScheduledTask -TaskName 'ServerControl Mechanical Connect'"));
  });

  await check('Windows listener start keeps the existing control-script invocation', async () => {
    const calls = [];
    const outcome = await keeper.startListener('192.0.2.10', { via: 'test' }, {
      platform: 'win32',
      spawnSyncApi(file, args, options) {
        calls.push({ file, args, options });
        return { status: 0, stdout: '', stderr: '' };
      },
      probeApi: async () => ({ state: 'alive', via: 'EADDRINUSE' }),
      heartbeatRunner: async () => {},
      sleepApi: async () => {},
      bindWaitMs: 1,
      pollMs: 1
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'powershell.exe');
    assert.deepEqual(calls[0].args.slice(-4), ['-File', path.resolve(__dirname, '..', 'tools', 'full-remote-access-control.ps1'), '-Action', 'Start']);
    assert.equal(calls[0].options.cwd, path.resolve(__dirname, '..'));
    assert.equal(outcome.exitCode, 0);
  });

  await check('resident outcome policy exits nonzero failures without continuing', async () => {
    assert.deepEqual(keeper.residentOutcomeDecision({ exitCode: 7, message: 'probe refused' }), {
      action: 'fault', exitCode: 7, reason: 'probe refused'
    });
    assert.deepEqual(keeper.residentOutcomeDecision({ exitCode: 0, done: true, message: 'off' }), {
      action: 'stop', exitCode: 0, reason: 'stop sentinel present'
    });
    assert.deepEqual(keeper.residentOutcomeDecision({ exitCode: 0, message: 'steady' }), {
      action: 'continue', exitCode: 0, reason: 'tick succeeded'
    });
    assert.deepEqual(keeper.residentOutcomeDecision(null), {
      action: 'fault', exitCode: 1, reason: 'invalid tick outcome'
    });
  });

  await check('Linux stop signals only an exact same-uid listener and proves the port released', async () => {
    const observations = [
      { listeners: [listener()] },
      { listeners: [listener()] },
      { listeners: [] }
    ];
    let probeCalls = 0;
    const signals = [];
    const outcome = await keeper.stopLinuxOwnedListener({
      listenerProbe: () => {
        probeCalls += 1;
        return observations.shift();
      },
      fsApi: identityFs(),
      procRoot: '/proc',
      killApi: (pid, signal) => signals.push({ pid, signal }),
      sleepApi: async () => {},
      now: () => 0,
      identityOptions: {
        getuid: () => 1000,
        execPath: '/runtime/node',
        listenerHost: '/repo/tools/full-remote-access-listener-host.js'
      }
    });
    assert.deepEqual(outcome, { action: 'stopped', pid: 42 });
    assert.deepEqual(signals, [{ pid: 42, signal: 'SIGTERM' }]);
    assert.equal(probeCalls, 3);
  });

  await check('Linux stop refuses a different uid without signalling it', async () => {
    let signals = 0;
    const observations = [
      { listeners: [listener()] },
      { listeners: [listener()] },
      { listeners: [] }
    ];
    await assert.rejects(keeper.stopLinuxOwnedListener({
      listenerProbe: () => observations.shift(),
      fsApi: identityFs({ uid: 1001 }),
      procRoot: '/proc',
      killApi: () => { signals += 1; },
      identityOptions: {
        getuid: () => 1000,
        execPath: '/runtime/node',
        listenerHost: '/repo/tools/full-remote-access-listener-host.js'
      }
    }), error => error && error.code === 'FRA_LIFECYCLE_LISTENER_NOT_OWNED');
    assert.equal(signals, 0);
  });

  await check('the real Linux procfs inventory sees a live socket and its release', async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    try {
      assert.equal(keeper.portListening(port, false, { platform: 'linux' }), true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    assert.equal(keeper.portListening(port, true, { platform: 'linux' }), false);
  }, { skip: process.platform !== 'linux' ? 'requires native Linux procfs; injected lifecycle contracts run on every platform' : false });
});
