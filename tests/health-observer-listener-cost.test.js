'use strict';

// watcher-cost-build (session 6f84bf9b): proves the health observer's listener
// probing is cheap-first. Before this change, buildSystemContext().getListener()
// called serviceControl.defaultProbe() -- a full PowerShell spawn -- for every
// declared loopback port on every sweep, whether or not anything was listening.
// This suite proves (a) getListener consumes precomputed cheap results and never
// spawns the expensive probe for a down port, (b) with no precomputed results it
// still behaves exactly as before (backward compatible), and (c)
// collectListenerProbes resolves the right ports and defers to the cheap probe.
//
// The cheap probe itself (serviceControl.probeListenerCheap) is proven not to
// spawn when a port is down by tests/service-control-listener-liveness.test.js;
// this suite proves the observer WIRING that routes through it.

const test = require('node:test');
const assert = require('node:assert');

const observer = require('../src/lib/supervision/observer.js');

test('getListener: a precomputed empty result reads "nothing listening" and the expensive probe is NEVER called', () => {
  let expensiveCalls = 0;
  const expensiveProbe = port => { expensiveCalls += 1; return { port, listeners: [] }; };

  const listenerResults = new Map([[3889, { port: 3889, listeners: [] }]]);
  const ctx = observer.buildSystemContext({ listenerResults, listenerProbe: expensiveProbe });

  const result = ctx.getListener(3889);
  assert.equal(result, null, 'an empty precomputed result means nothing is listening');
  assert.equal(expensiveCalls, 0, 'a down port must cost ZERO expensive (PowerShell) probes');
});

test('getListener: with no precomputed results, the direct probe is used exactly once per port (backward compatible)', () => {
  let calls = 0;
  const probe = port => { calls += 1; return { port, listeners: [] }; };

  const ctx = observer.buildSystemContext({ listenerProbe: probe });
  ctx.getListener(3889);
  ctx.getListener(3889); // cached within a sweep
  assert.equal(calls, 1, 'the legacy path still probes, and still caches per sweep');
});

test('getListener: an "up" precomputed result carries the SAME identity fields defaultProbe would have, with no extra spawn', () => {
  let expensiveCalls = 0;
  const expensiveProbe = () => { expensiveCalls += 1; return { port: 3889, listeners: [] }; };

  const upListener = { localAddress: '127.0.0.1', localPort: 3889, pid: 4242, startTime: '2026-08-10T00:00:00.000Z' };
  const listenerResults = new Map([[3889, { port: 3889, listeners: [upListener] }]]);
  const ctx = observer.buildSystemContext({ listenerResults, listenerProbe: expensiveProbe });

  const result = ctx.getListener(3889);
  assert.ok(result && result.pid === 4242, 'a real precomputed listener is surfaced with its identity intact');
  assert.equal(expensiveCalls, 0, 'the identity probe was already paid for in the pre-pass; getListener must not spawn again');
});

test('collectListenerProbes: probes each declared fixed port once and skips entries with no port', async () => {
  const processes = [
    { id: 'dashboard', port: 3889, rungs: {} },
    { id: 'sidecar', port: 3888, rungs: {} },
    { id: 'worker', port: null, rungs: {} } // no port -> never probed
  ];

  const probed = [];
  const cheapProbe = async port => { probed.push(port); return { port, listeners: [] }; };

  const results = await observer.collectListenerProbes(processes, { probe: cheapProbe });

  assert.deepEqual(probed.sort((a, b) => a - b), [3888, 3889], 'exactly the two declared ports are probed');
  assert.equal(results.get(3889).listeners.length, 0);
  assert.ok(!results.has(null), 'a null port never enters the result map');
});

test('collectListenerProbes: a dynamic portRange listener contributes the port its runtime state file records', async () => {
  const processes = [
    { id: 'mission-bridge', portRange: { first: 4610, last: 4619 }, stateFile: 'state/does-not-exist-here.json', rungs: {} }
  ];

  const probed = [];
  const cheapProbe = async port => { probed.push(port); return { port, listeners: [] }; };
  // Injected reader stands in for the runtime discovery file.
  const io = { readFileSync: () => JSON.stringify({ port: 4611, pid: 5001 }) };

  const results = await observer.collectListenerProbes(processes, { probe: cheapProbe, io });
  assert.deepEqual(probed, [4611], 'the concrete runtime port is resolved without a spawn and probed');
  assert.ok(results.has(4611));
});

test('collectListenerProbes: a probe that throws is stored as undefined (honest UNKNOWN), not a fabricated "nothing there"', async () => {
  const processes = [{ id: 'dashboard', port: 3889, rungs: {} }];
  const throwingProbe = async () => { throw new Error('probe blew up'); };

  const results = await observer.collectListenerProbes(processes, { probe: throwingProbe });
  assert.ok(results.has(3889), 'the port is present in the map');
  assert.equal(results.get(3889), undefined, 'a failed probe is undefined so getListener reports UNKNOWN, never absent');
});
